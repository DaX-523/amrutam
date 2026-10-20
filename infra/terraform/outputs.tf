output "cluster_name" { value = module.eks.cluster_name }
output "db_endpoint" { value = aws_db_instance.primary.address }
output "db_replica_endpoint" { value = aws_db_instance.replica.address }
output "redis_primary_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "prescriptions_bucket" { value = aws_s3_bucket.prescriptions.bucket }
output "app_role_arn" { value = module.app_irsa.iam_role_arn }
output "waf_acl_arn" { value = aws_wafv2_web_acl.api.arn }
output "app_secret_name" { value = aws_secretsmanager_secret.app.name }
