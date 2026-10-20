import type { AppConfig } from '../config/env.js';
import { SmtpMailer, type Mailer } from './mailer.js';
import { S3Storage, type ObjectStorage } from './storage.js';

export function createStorage(config: AppConfig): ObjectStorage {
  return new S3Storage({
    bucket: config.S3_BUCKET,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  });
}

export function createMailer(config: AppConfig): Mailer {
  return new SmtpMailer({ host: config.SMTP_HOST, port: config.SMTP_PORT, from: config.MAIL_FROM });
}
