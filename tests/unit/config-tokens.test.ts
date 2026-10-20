import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { TokenService } from '../../src/infra/tokens.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SIGNING_KEYS: `k1:${'s'.repeat(40)}`,
  JWT_ACTIVE_KID: 'k1',
  ENCRYPTION_KEYS: `e1:${randomBytes(32).toString('base64')}`,
  ENCRYPTION_ACTIVE_KEY_ID: 'e1',
  BLIND_INDEX_KEY: 'b'.repeat(40),
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(40),
};

describe('config', () => {
  it('parses keyrings and defaults', () => {
    const c = loadConfig(base);
    expect(c.JWT_SIGNING_KEYS.get('k1')?.length).toBe(40);
    expect(c.ACCESS_TOKEN_TTL_SEC).toBe(900);
  });

  it('refuses to boot with weak or inconsistent secrets, without echoing values', () => {
    expect(() => loadConfig({ ...base, JWT_SIGNING_KEYS: 'k1:short' })).toThrow(/at least 32 bytes/);
    expect(() => loadConfig({ ...base, JWT_ACTIVE_KID: 'missing' })).toThrow(/JWT_ACTIVE_KID/);
    expect(() =>
      loadConfig({ ...base, ENCRYPTION_KEYS: `e1:${randomBytes(16).toString('base64')}` }),
    ).toThrow();
    try {
      loadConfig({ ...base, PAYMENT_WEBHOOK_SECRET: 'tiny-secret' });
    } catch (e) {
      expect(String(e)).not.toContain('tiny-secret');
    }
  });
});

describe('TokenService', () => {
  const make = (keys: Map<string, Buffer>, activeKid: string) =>
    new TokenService({
      keys,
      activeKid,
      issuer: 'iss',
      audience: 'aud',
      accessTtlSec: 60,
      mfaChallengeTtlSec: 60,
    });
  const k1 = Buffer.from('a'.repeat(40));
  const k2 = Buffer.from('b'.repeat(40));

  it('verifies its own tokens and rejects token-type confusion', async () => {
    const svc = make(new Map([['k1', k1]]), 'k1');
    const access = await svc.signAccess({ sub: 'u1', role: 'patient', amr: ['pwd'], sid: 's1' });
    expect(await svc.verifyAccess(access)).toMatchObject({ sub: 'u1', role: 'patient', sid: 's1' });
    const challenge = await svc.signMfaChallenge({ sub: 'u1', sid: 's1' });
    expect(await svc.verifyAccess(challenge)).toBeNull(); // an MFA challenge is not an access token
    expect(await svc.verifyMfaChallenge(access)).toBeNull();
  });

  it('supports key rotation via kid and rejects unknown keys / alg=none', async () => {
    const old = make(new Map([['k1', k1]]), 'k1');
    const token = await old.signAccess({ sub: 'u1', role: 'doctor', amr: ['pwd', 'otp'], sid: 's' });
    const rotated = make(
      new Map([
        ['k1', k1],
        ['k2', k2],
      ]),
      'k2',
    );
    expect(await rotated.verifyAccess(token)).not.toBeNull();
    const retired = make(new Map([['k2', k2]]), 'k2');
    expect(await retired.verifyAccess(token)).toBeNull();
    const [, payload] = token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${payload}.`;
    expect(await old.verifyAccess(none)).toBeNull();
  });
});
