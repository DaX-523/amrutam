# ───────────────────────── KMS (one key per data domain, auto-rotated yearly) ─────────────────────────
resource "aws_kms_key" "this" {
  for_each                = toset(["rds", "redis", "s3", "secrets", "eks", "backup"])
  description             = "${local.name} ${each.key}"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "this" {
  for_each      = aws_kms_key.this
  name          = "alias/${local.name}-${each.key}"
  target_key_id = each.value.key_id
}

resource "aws_kms_key" "dr_rds" {
  provider            = aws.dr
  description         = "${local.name} rds backups (DR)"
  enable_key_rotation = true
}

resource "aws_kms_key" "dr_s3" {
  provider            = aws.dr
  description         = "${local.name} s3 replica (DR)"
  enable_key_rotation = true
}

# ───────────────────────── application secrets ─────────────────────────
# Values (JWT keyring, field-encryption keyring, webhook secret...) are set out-of-band
# and synced to pods by External Secrets; Terraform never sees them.
resource "aws_secretsmanager_secret" "app" {
  name       = "amrutam/${var.environment}/app"
  kms_key_id = aws_kms_key.this["secrets"].arn
  replica {
    region = var.dr_region
  }
}

# ───────────────────────── WAF on the public ALB ─────────────────────────
resource "aws_wafv2_web_acl" "api" {
  name  = "${local.name}-api"
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesCommonRuleSet          = 10
      AWSManagedRulesKnownBadInputsRuleSet  = 20
      AWSManagedRulesSQLiRuleSet            = 30
      AWSManagedRulesAmazonIpReputationList = 40
    }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  # Edge rate limit (per IP / 5 min) in front of the app's own per-user limits.
  rule {
    name     = "rate-limit-per-ip"
    priority = 50
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 3000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-api"
    sampled_requests_enabled   = true
  }
}
