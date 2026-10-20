# Prescription PDFs: private, versioned, KMS-encrypted, replicated to the DR region.
resource "aws_s3_bucket" "prescriptions" {
  bucket = "amrutam-prescriptions-${var.environment}"
}

resource "aws_s3_bucket_public_access_block" "prescriptions" {
  bucket                  = aws_s3_bucket.prescriptions.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "prescriptions" {
  bucket = aws_s3_bucket.prescriptions.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "prescriptions" {
  bucket = aws_s3_bucket.prescriptions.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this["s3"].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "prescriptions_tls_only" {
  bucket = aws_s3_bucket.prescriptions.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.prescriptions.arn, "${aws_s3_bucket.prescriptions.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "prescriptions" {
  bucket = aws_s3_bucket.prescriptions.id
  rule {
    id     = "tiering-and-retention"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 365
      storage_class = "GLACIER_IR"
    }
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
}

resource "aws_s3_bucket" "prescriptions_dr" {
  provider = aws.dr
  bucket   = "amrutam-prescriptions-${var.environment}-dr"
}

resource "aws_s3_bucket_versioning" "prescriptions_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.prescriptions_dr.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_iam_role" "replication" {
  name_prefix = "${local.name}-s3-repl-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "s3.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "replication" {
  role = aws_iam_role.replication.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = aws_s3_bucket.prescriptions.arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${aws_s3_bucket.prescriptions.arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${aws_s3_bucket.prescriptions_dr.arn}/*" },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.this["s3"].arn },
      { Effect = "Allow", Action = ["kms:Encrypt"], Resource = aws_kms_key.dr_s3.arn },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "prescriptions" {
  depends_on = [aws_s3_bucket_versioning.prescriptions, aws_s3_bucket_versioning.prescriptions_dr]
  bucket     = aws_s3_bucket.prescriptions.id
  role       = aws_iam_role.replication.arn
  rule {
    id     = "dr"
    status = "Enabled"
    filter {}
    delete_marker_replication { status = "Enabled" }
    source_selection_criteria {
      sse_kms_encrypted_objects { status = "Enabled" }
    }
    destination {
      bucket        = aws_s3_bucket.prescriptions_dr.arn
      storage_class = "STANDARD_IA"
      encryption_configuration { replica_kms_key_id = aws_kms_key.dr_s3.arn }
    }
  }
}

resource "aws_s3_bucket_public_access_block" "prescriptions_dr" {
  provider                = aws.dr
  bucket                  = aws_s3_bucket.prescriptions_dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "prescriptions_dr" {
  provider = aws.dr
  bucket   = aws_s3_bucket.prescriptions_dr.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.dr_s3.arn
    }
    bucket_key_enabled = true
  }
}
