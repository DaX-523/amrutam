import type { Redis } from 'ioredis';
import type { AppConfig } from './config/env.js';
import { Cache } from './infra/cache.js';
import { FieldCipher } from './infra/crypto.js';
import { createDb, type DbHandles } from './infra/db.js';
import { createLogger, type Logger } from './infra/logger.js';
import { Metrics } from './infra/metrics.js';
import { PasswordHasher } from './infra/passwords.js';
import { createQueues, closeQueues, type Queues } from './infra/queue.js';
import { bullConnectionOptions, createRedis } from './infra/redis.js';
import { TokenService } from './infra/tokens.js';
import { createMailer, createStorage } from './infra/adapters.js';
import type { Mailer } from './infra/mailer.js';
import type { ObjectStorage } from './infra/storage.js';
import { AdminService } from './modules/admin/admin.service.js';
import { AnalyticsService } from './modules/admin/analytics.service.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { SessionRevocations } from './modules/auth/session-revocations.js';
import { AvailabilityService } from './modules/availability/availability.service.js';
import { BookingsService } from './modules/bookings/bookings.service.js';
import { ConsultationsService } from './modules/consultations/consultations.service.js';
import { DoctorsService } from './modules/doctors/doctors.service.js';
import {
  MockPaymentGateway,
  ResilientPaymentGateway,
  type PaymentGateway,
} from './modules/payments/gateway.js';
import { PaymentsService } from './modules/payments/payments.service.js';
import { PrescriptionsService } from './modules/prescriptions/prescriptions.service.js';
import { UsersService } from './modules/users/users.service.js';

/**
 * Composition root (dependency injection by constructor). Every service receives its
 * collaborators explicitly; nothing reaches for globals. Tests build the same graph with
 * overrides (e.g. a fake payment gateway) instead of monkey-patching modules.
 */
export interface Infra {
  config: AppConfig;
  logger: Logger;
  metrics: Metrics;
  db: DbHandles;
  redis: Redis;
  queues: Queues;
  cache: Cache;
  cipher: FieldCipher;
  passwords: PasswordHasher;
  tokens: TokenService;
  gateway: PaymentGateway;
  storage: ObjectStorage;
  mailer: Mailer;
}

export interface Services {
  audit: AuditService;
  revocations: SessionRevocations;
  auth: AuthService;
  users: UsersService;
  doctors: DoctorsService;
  availability: AvailabilityService;
  bookings: BookingsService;
  consultations: ConsultationsService;
  payments: PaymentsService;
  prescriptions: PrescriptionsService;
  admin: AdminService;
  analytics: AnalyticsService;
}

export type Container = Infra & Services & { close(): Promise<void> };

export function createContainer(config: AppConfig, overrides: Partial<Infra> = {}): Container {
  const logger =
    overrides.logger ??
    createLogger({
      level: config.LOG_LEVEL,
      service: config.SERVICE_NAME,
      pretty: config.NODE_ENV === 'development',
    });
  const metrics = overrides.metrics ?? new Metrics(config.SERVICE_NAME);
  const db =
    overrides.db ??
    createDb({
      url: config.DATABASE_URL,
      readUrl: config.DATABASE_READ_URL,
      poolMax: config.DB_POOL_MAX,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      appName: config.SERVICE_NAME,
    });
  const redis = overrides.redis ?? createRedis(config.REDIS_URL);
  const queues = overrides.queues ?? createQueues(bullConnectionOptions(config.REDIS_URL));
  const cache = overrides.cache ?? new Cache(redis, logger, metrics);
  const cipher = overrides.cipher ?? new FieldCipher(config.ENCRYPTION_KEYS, config.ENCRYPTION_ACTIVE_KEY_ID);
  const passwords = overrides.passwords ?? new PasswordHasher();
  const tokens =
    overrides.tokens ??
    new TokenService({
      keys: config.JWT_SIGNING_KEYS,
      activeKid: config.JWT_ACTIVE_KID,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      accessTtlSec: config.ACCESS_TOKEN_TTL_SEC,
      mfaChallengeTtlSec: config.MFA_CHALLENGE_TTL_SEC,
    });

  const gateway =
    overrides.gateway ??
    new ResilientPaymentGateway(
      new MockPaymentGateway({
        failureRate: config.MOCK_GATEWAY_FAILURE_RATE,
        latencyMs: config.MOCK_GATEWAY_LATENCY_MS,
      }),
      { logger, metrics },
    );
  const storage = overrides.storage ?? createStorage(config);
  const mailer = overrides.mailer ?? createMailer(config);

  const infra: Infra = {
    config,
    logger,
    metrics,
    db,
    redis,
    queues,
    cache,
    cipher,
    passwords,
    tokens,
    gateway,
    storage,
    mailer,
  };

  const audit = new AuditService({ db: db.writer, logger });
  const revocations = new SessionRevocations(redis, config.ACCESS_TOKEN_TTL_SEC, logger);
  const auth = new AuthService({ db, passwords, tokens, cipher, audit, metrics, config, revocations });
  const users = new UsersService({ db, cipher, audit, auth, passwords, config });
  const doctors = new DoctorsService({ db, cache, audit, config });
  const availability = new AvailabilityService({ db, cache, audit });
  const bookings = new BookingsService({ db, cipher, audit, gateway, cache, metrics, logger, config });
  const consultations = new ConsultationsService({ db, cipher, audit, cache, metrics, config });
  const payments = new PaymentsService({ db, audit, gateway, cache, metrics, logger, config });
  const prescriptions = new PrescriptionsService({ db, cipher, audit, storage });
  const admin = new AdminService({ db, audit, auth, cache });
  const analytics = new AnalyticsService({ db, config });

  return {
    ...infra,
    audit,
    revocations,
    auth,
    users,
    doctors,
    availability,
    bookings,
    consultations,
    payments,
    prescriptions,
    admin,
    analytics,
    async close() {
      await closeQueues(queues);
      redis.disconnect();
      await db.close();
    },
  };
}
