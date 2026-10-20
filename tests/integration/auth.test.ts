import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idemKey, setupApp, uniq, type TestCtx } from './helpers.js';

const PASSWORD = 'a-very-long-passphrase';

describe('auth & user lifecycle', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await setupApp();
  });
  afterAll(() => t.close());

  const register = (email: string, role: 'patient' | 'doctor' = 'patient') =>
    t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        email,
        password: PASSWORD,
        fullName: 'Test User',
        role,
        phone: '+919800000001',
        consent: true,
      },
    });
  const login = (email: string, password = PASSWORD) =>
    t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

  it('registers, stores PHI encrypted at rest, and logs in', async () => {
    const email = `p-${uniq()}@test.local`;
    const reg = await register(email.toUpperCase());
    expect(reg.statusCode).toBe(201);
    expect(reg.json().email).toBe(email); // normalised

    const row = await t.c.db.writer
      .selectFrom('profiles')
      .select(['phone_enc', 'phone_bidx'])
      .where('user_id', '=', reg.json().id)
      .executeTakeFirstOrThrow();
    expect(row.phone_enc).toMatch(/^enc:k1:/);
    expect(row.phone_enc).not.toContain('9800000001');
    expect(row.phone_bidx).toHaveLength(64);

    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'authenticated',
      tokenType: 'Bearer',
      mfaEnrollmentRequired: false,
    });
    const me = await t.app.inject({
      url: '/v1/me',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    });
    expect(me.json().profile.phone).toBe('+919800000001');
  });

  it('returns the same error for unknown email and wrong password (no enumeration)', async () => {
    const email = `p-${uniq()}@test.local`;
    await register(email);
    const wrong = await login(email, 'not-the-password!!');
    const unknown = await login(`nobody-${uniq()}@test.local`, 'not-the-password!!');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().detail).toBe(unknown.json().detail);
  });

  it('locks the account after repeated failures', async () => {
    const email = `p-${uniq()}@test.local`;
    await register(email);
    for (let i = 0; i < 5; i++) expect((await login(email, 'wrong-password-xyz')).statusCode).toBe(401);
    const locked = await login(email); // even the right password
    expect(locked.statusCode).toBe(423);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const email = `p-${uniq()}@test.local`;
    await register(email);
    const first = (await login(email)).json();
    const refresh = (token: string) =>
      t.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: token } });

    const second = await refresh(first.refreshToken);
    expect(second.statusCode).toBe(200);
    expect(second.json().refreshToken).not.toBe(first.refreshToken);

    // Attacker replays the old token -> reuse detected -> family revoked...
    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);
    // ...so even the legitimate latest token stops working.
    expect((await refresh(second.json().refreshToken)).statusCode).toBe(401);
    const audit = await t.c.db.writer
      .selectFrom('audit_logs')
      .select('action')
      .where('action', '=', 'auth.refresh_reuse_detected')
      .execute();
    expect(audit.length).toBeGreaterThan(0);
  });

  it('forces doctors through TOTP enrolment, then requires the second factor at login', async () => {
    const email = `d-${uniq()}@test.local`;
    await register(email, 'doctor');
    const pwOnly = (await login(email)).json();
    expect(pwOnly).toMatchObject({ status: 'authenticated', mfaEnrollmentRequired: true });
    const auth = { authorization: `Bearer ${pwOnly.accessToken}` };

    // Password-only session cannot use doctor features.
    const blocked = await t.app.inject({ url: '/v1/doctors/me', headers: auth });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('MFA_REQUIRED');

    const enroll = (await t.app.inject({ method: 'POST', url: '/v1/auth/mfa/enroll', headers: auth })).json();
    expect(enroll.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    const activated = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/activate',
      headers: auth,
      payload: { code: await generate({ secret: enroll.secret }) },
    });
    expect(activated.statusCode).toBe(200);
    // Old password-only session was revoked.
    expect((await t.app.inject({ url: '/v1/me', headers: auth })).statusCode).toBe(401);

    const challenge = (await login(email)).json();
    expect(challenge.status).toBe('mfa_required');
    const bad = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { mfaToken: challenge.mfaToken, code: '000000' },
    });
    expect(bad.statusCode).toBe(401);
    // The code used for activation cannot be replayed within the same time step.
    const replay = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { mfaToken: challenge.mfaToken, code: await generate({ secret: enroll.secret }) },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('cuts off a suspended user immediately, even with a still-valid access token', async () => {
    const email = `p-${uniq()}@test.local`;
    const id = (await register(email)).json().id;
    const token = (await login(email)).json().accessToken;
    const admin = await t.c.tokens.signAccess({
      sub: (
        await t.c.db.writer
          .insertInto('users')
          .values({ email: `a-${uniq()}@test.local`, password_hash: '!', role: 'admin' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id,
      role: 'admin',
      amr: ['pwd', 'otp'],
      sid: crypto.randomUUID(),
    });

    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/admin/users/${id}/status`,
      headers: { authorization: `Bearer ${admin}`, 'idempotency-key': idemKey() },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await t.app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(401);
    expect((await login(email)).statusCode).toBe(403);
  });

  it('rejects weak passwords and unknown fields', async () => {
    const weak = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'idempotency-key': idemKey() },
      payload: { email: `w-${uniq()}@test.local`, password: 'short', fullName: 'Weak', consent: true },
    });
    expect(weak.statusCode).toBe(400);
    const extra = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'idempotency-key': idemKey() },
      payload: {
        email: `x-${uniq()}@test.local`,
        password: PASSWORD,
        fullName: 'Mass Assign',
        consent: true,
        role: 'admin',
      },
    });
    expect(extra.statusCode).toBe(400); // role=admin is not an allowed value (mass assignment)
  });
});
