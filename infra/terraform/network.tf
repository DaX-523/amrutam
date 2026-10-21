# 3-AZ VPC: public (ALB), private (EKS nodes), database (RDS/ElastiCache, no internet route).
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.7"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets   = [for i in range(3) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets  = [for i in range(3) : cidrsubnet(var.vpc_cidr, 4, i + 1)]
  database_subnets = [for i in range(3) : cidrsubnet(var.vpc_cidr, 8, 200 + i)]

  enable_nat_gateway     = true
  one_nat_gateway_per_az = true # no cross-AZ single point of failure
  enable_dns_hostnames   = true

  create_database_subnet_group       = true
  create_database_subnet_route_table = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_log_group = true
  create_flow_log_cloudwatch_iam_role  = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# Keep AWS API traffic (S3, KMS, Secrets Manager) off the internet.
module "vpc_endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 6.7"

  vpc_id             = module.vpc.vpc_id
  security_group_ids = [aws_security_group.vpc_endpoints.id]
  endpoints = {
    s3             = { service = "s3", service_type = "Gateway", route_table_ids = module.vpc.private_route_table_ids }
    kms            = { service = "kms", private_dns_enabled = true, subnet_ids = module.vpc.private_subnets }
    secretsmanager = { service = "secretsmanager", private_dns_enabled = true, subnet_ids = module.vpc.private_subnets }
  }
}

resource "aws_security_group" "vpc_endpoints" {
  name_prefix = "${local.name}-vpce-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    description = "HTTPS from VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
}
