import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import { inject } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createContainer, type Container, type Infra } from '../../src/container.js';
import type { UserRole } from '../../src/db/types.js';
import { RecordingMailer } from '../../src/infra/mailer.js';
import { InMemoryStorage } from '../../src/infra/storage.js';
import type { AuthMethod } from '../../src/infra/tokens.js';
import type { sql } from 'kysely';

export const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SIGNING_KEYS: `test-k1:${randomBytes(32).toString('hex')}`,
  JWT_ACTIVE_KID: 'test-k1',
  ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
  ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  BLIND_INDEX_KEY: randomBytes(32).toString('hex'),
  PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  MOCK_GATEWAY_LATENCY_MS: '0',
  MOCK_CHECKOUT_ENABLED: 'true',
  RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
  BOOKING_RATE_LIMIT_MAX: '100000',
  DB_POOL_MAX: '25',
};

export interface TestCtx {
  app: App;
  c: Container;
  mailer: RecordingMailer;
  storage: InMemoryStorage;
  close(): Promise<void>;
}

export async function setupApp(
  opts: { env?: Record<string, string>; overrides?: Partial<Infra> } = {},
): Promise<TestCtx> {
  const config: AppConfig = loadConfig({
    ...TEST_ENV,
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    ...opts.env,
  });
  const mailer = new RecordingMailer();
  const storage = new InMemoryStorage();
  const c = createContainer(config, {
    logger: pino({ level: 'silent' }),
    mailer,
    storage,
    ...opts.overrides,
  });
  await c.redis.connect();
  await c.redis.flushdb();
  const app = await buildApp(c);
  await app.ready();
  return {
    app,
    c,
    mailer,
    storage,
    async close() {
      await app.close();
      await c.close();
    },
  };
}

export const uniq = () => randomBytes(5).toString('hex');
export const idemKey = () => `test-${randomBytes(8).toString('hex')}`;

/** Inserts a user directly (fast; bypasses argon2) and mints an access token. */
export async function createUser(
  c: Container,
  role: UserRole,
  opts: { amr?: AuthMethod[]; name?: string } = {},
) {
  const u = await c.db.writer
    .insertInto('users')
    .values({ email: `${role}-${uniq()}@test.local`, password_hash: '!', role })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();
  await c.db.writer
    .insertInto('profiles')
    .values({
      user_id: u.id,
      full_name: opts.name ?? `${role} ${uniq()}`,
      phone_enc: null,
      phone_bidx: null,
      dob_enc: null,
      gender: null,
      city: null,
      consent_version: 'test',
      consent_given_at: new Date(),
    })
    .execute();
  const amr = opts.amr ?? (role === 'patient' ? ['pwd'] : ['pwd', 'otp']);
  const token = await c.tokens.signAccess({ sub: u.id, role, amr, sid: crypto.randomUUID() });
  return { id: u.id, email: u.email, token, auth: { authorization: `Bearer ${token}` } };
}

export async function createDoctor(
  c: Container,
  opts: {
    verified?: boolean;
    feePaise?: number;
    specialties?: string[];
    city?: string;
    name?: string;
    rating?: number;
  } = {},
) {
  const user = await createUser(c, 'doctor', { name: opts.name });
  await c.db.writer
    .insertInto('doctors')
    .values({
      user_id: user.id,
      display_name: opts.name ?? `Dr. Test ${uniq()}`,
      registration_number: `REG-${uniq()}`,
      specialties: opts.specialties ?? ['general-ayurveda'],
      languages: ['english'],
      qualifications: ['BAMS'],
      years_experience: 5,
      fee_paise: opts.feePaise ?? 50_000,
      city: opts.city ?? 'Delhi',
      bio: null,
      rating: opts.rating ?? 4.5,
      verified_at: opts.verified === false ? null : new Date(),
      verified_by: null,
    })
    .execute();
  return user;
}

/** Creates one available slot starting `inMinutes` from now (minute-aligned, unique offset). */
export async function createSlot(c: Container, doctorId: string, inMinutes = 120, durationMin = 15) {
  const starts = new Date(Date.now() + inMinutes * 60_000);
  starts.setSeconds(0, 0);
  return c.db.writer
    .insertInto('availability_slots')
    .values({
      doctor_id: doctorId,
      starts_at: starts,
      ends_at: new Date(starts.getTime() + durationMin * 60_000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function book(t: TestCtx, patientAuth: Record<string, string>, slotId: string, key = idemKey()) {
  return t.app.inject({
    method: 'POST',
    url: '/v1/bookings',
    headers: { ...patientAuth, 'idempotency-key': key },
    payload: { slotId, reason: 'Headache for three days' },
  });
}

export async function payViaWebhook(
  t: TestCtx,
  paymentId: string,
  outcome: 'success' | 'failure' = 'success',
) {
  const p = await t.c.db.writer
    .selectFrom('payments')
    .selectAll()
    .where('id', '=', paymentId)
    .executeTakeFirstOrThrow();
  const { body, signature } = t.c.payments.buildMockWebhook(p.provider_order_id!, p.amount_paise, outcome);
  return t.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook',
    headers: { 'content-type': 'application/json', 'x-mockpay-signature': signature },
    payload: body,
  });
}

export async function countRows(c: Container, query: ReturnType<typeof sql>) {
  const r = await query.execute(c.db.writer);
  return Number((r.rows[0] as { n: string }).n);
}
