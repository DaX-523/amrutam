# ─────────────────────────────────────────────────────────────────────────────
# REFERENCE INFRASTRUCTURE — written for review, NEVER applied for this assessment
# (applying it would create billable AWS resources). CI only runs `fmt` and
# `validate` with `-backend=false`, which needs no AWS account or credentials.
# ─────────────────────────────────────────────────────────────────────────────
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Remote state with locking (S3 native lockfile).
  backend "s3" {
    bucket       = "amrutam-terraform-state"
    key          = "telemed/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = local.tags }
}

# Disaster-recovery region (backups / replication targets).
provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags { tags = local.tags }
}
