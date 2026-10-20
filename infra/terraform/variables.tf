variable "environment" {
  type        = string
  description = "staging | prod"
}

variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai: data residency for Indian health data
}

variable "dr_region" {
  type    = string
  default = "ap-south-2" # Hyderabad: in-country DR keeps data residency
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.large"
}

variable "redis_node_type" {
  type    = string
  default = "cache.r6g.large"
}

variable "eks_node_instance_types" {
  type    = list(string)
  default = ["m6g.large"]
}

variable "backup_retention_days" {
  type    = number
  default = 35
}

locals {
  name = "amrutam-${var.environment}"
  azs  = ["${var.region}a", "${var.region}b", "${var.region}c"]
  tags = {
    project     = "amrutam-telemed"
    environment = var.environment
    managed_by  = "terraform"
    data_class  = "phi"
  }
}
