import { z } from 'zod';

/**
 * All configuration comes from environment variables (12-factor). Secrets are never
 * read from files committed to the repo. The process refuses to boot on invalid config.
 */

/** "id1:secret1,id2:secret2" -> Map(id -> secret). Used for JWT and encryption keyrings. */
const keyring = (minBytes: number, encoding: 'utf8' | 'base64') =>
  z
    .string()
    .min(1)
    .transform((raw, ctx) => {
      const ring = new Map<string, Buffer>();
      for (const entry of raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const idx = entry.indexOf(':');
        if (idx <= 0) {
          ctx.addIssue({ code: 'custom', message: `keyring entry must be "<id>:<secret>"` });
          return z.NEVER;
        }
        const id = entry.slice(0, idx);
        const secret = Buffer.from(entry.slice(idx + 1), encoding);
        if (secret.length < minBytes) {
          ctx.addIssue({ code: 'custom', message: `key "${id}" must be at least ${minBytes} bytes` });
          return z.NEVER;
        }
        ring.set(id, secret);
      }
      return ring;
    });

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SERVICE_NAME: z.string().default('amrutam-api'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9464),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_TIMEZONE: z.string().default('Asia/Kolkata'),
    TRUST_PROXY: bool.default(false),

    DATABASE_URL: z.url(),
    DATABASE_READ_URL: z.url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

    REDIS_URL: z.url(),

    JWT_SIGNING_KEYS: keyring(32, 'utf8'),
    JWT_ACTIVE_KID: z.string().min(1),
    JWT_ISSUER: z.string().default('amrutam-api'),
    JWT_AUDIENCE: z.string().default('amrutam-clients'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
    MFA_CHALLENGE_TTL_SEC: z.coerce.number().int().positive().default(300),
    MFA_ISSUER: z.string().default('Amrutam'),
    MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
    LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

    ENCRYPTION_KEYS: keyring(32, 'base64'),
    ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
    BLIND_INDEX_KEY: z.string().min(32),

    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    BOOKING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

    SLOT_HOLD_TTL_SEC: z.coerce.number().int().positive().default(600),
    MIN_BOOKING_LEAD_MIN: z.coerce.number().int().nonnegative().default(5),
    CANCELLATION_REFUND_WINDOW_MIN: z.coerce.number().int().nonnegative().default(120),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    PAYMENT_WEBHOOK_SECRET: z.string().min(32),
    MOCK_GATEWAY_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    MOCK_GATEWAY_LATENCY_MS: z.coerce.number().int().nonnegative().default(50),
    /** Exposes a dev-only "pay now" endpoint that simulates the provider's hosted checkout. */
    MOCK_CHECKOUT_ENABLED: bool.default(false),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('ap-south-1'),
    S3_BUCKET: z.string().default('amrutam-prescriptions'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    MAIL_FROM: z.string().default('Amrutam <no-reply@amrutam.local>'),

    OTEL_ENABLED: bool.default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://localhost:4318'),
  })
  .superRefine((env, ctx) => {
    if (!env.JWT_SIGNING_KEYS.has(env.JWT_ACTIVE_KID)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_ACTIVE_KID'], message: 'not present in JWT_SIGNING_KEYS' });
    }
    if (!env.ENCRYPTION_KEYS.has(env.ENCRYPTION_ACTIVE_KEY_ID)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENCRYPTION_ACTIVE_KEY_ID'],
        message: 'not present in ENCRYPTION_KEYS',
      });
    }
    for (const [id, key] of env.ENCRYPTION_KEYS) {
      if (key.length !== 32) {
        ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEYS'], message: `key "${id}" must be 32 bytes` });
      }
    }
  });

export type AppConfig = z.output<typeof EnvSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only print variable names and messages, never values (they may be secrets).
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
