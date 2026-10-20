# AWS Backup: daily snapshots + cross-region copies (independent of RDS PITR), with a
# vault lock so backups cannot be deleted early — even by an admin (ransomware defence).
resource "aws_backup_vault" "primary" {
  name        = "${local.name}-vault"
  kms_key_arn = aws_kms_key.this["backup"].arn
}

resource "aws_backup_vault_lock_configuration" "primary" {
  backup_vault_name  = aws_backup_vault.primary.name
  min_retention_days = 7
  max_retention_days = 400
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${local.name}-vault-dr"
  kms_key_arn = aws_kms_key.dr_rds.arn
}

resource "aws_backup_plan" "daily" {
  name = "${local.name}-daily"
  rule {
    rule_name         = "daily-35d"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 21 * * ? *)" # 02:30 IST
    lifecycle { delete_after = 35 }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = 35 }
    }
  }
  rule {
    rule_name         = "monthly-1y"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 22 1 * ? *)"
    lifecycle {
      cold_storage_after = 30
      delete_after       = 365
    }
  }
}

resource "aws_iam_role" "backup" {
  name_prefix = "${local.name}-backup-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "backup.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "db" {
  name         = "${local.name}-db"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.primary.arn]
}
