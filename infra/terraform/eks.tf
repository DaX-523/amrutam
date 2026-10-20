module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = local.name
  cluster_version = "1.31"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = false # API server reachable only from the VPC / VPN
  enable_irsa                    = true
  cluster_encryption_config      = { resources = ["secrets"], provider_key_arn = aws_kms_key.this["eks"].arn }
  cluster_enabled_log_types      = ["api", "audit", "authenticator"]

  eks_managed_node_groups = {
    app = {
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = var.eks_node_instance_types
      min_size       = 3 # one per AZ minimum
      desired_size   = 3
      max_size       = 12
      subnet_ids     = module.vpc.private_subnets
    }
  }
}

# IRSA role for api/worker pods: least privilege on exactly the resources they use.
module "app_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name = "${local.name}-app"
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["amrutam:amrutam-app"]
    }
  }
  role_policy_arns = { app = aws_iam_policy.app.arn }
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "PrescriptionObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.prescriptions.arn}/prescriptions/*"]
  }
  statement {
    sid       = "UseDataKeys"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this["s3"].arn, aws_kms_key.this["secrets"].arn]
  }
  statement {
    sid       = "ReadAppSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn]
  }
}

resource "aws_iam_policy" "app" {
  name   = "${local.name}-app"
  policy = data.aws_iam_policy_document.app.json
}
