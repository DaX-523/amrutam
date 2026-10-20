import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import QRCode from 'qrcode';
import type { AppConfig } from '../../config/env.js';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import { MFA_REQUIRED_ROLES } from '../../domain/rbac-policy.js';
import type { User, UserRole } from '../../db/types.js';
import { blindIndex, randomToken, sha256Hex, type FieldCipher } from '../../infra/crypto.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import type { Metrics } from '../../infra/metrics.js';
import type { PasswordHasher } from '../../infra/passwords.js';
import type { AuthMethod, TokenService } from '../../infra/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RegisterInput } from './auth.schemas.js';
import type { SessionRevocations } from './session-revocations.js';

export const CONSENT_VERSION = '2026-01';
const MFA_AAD = 'users.mfa_secret';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export type LoginResult =
  | (TokenPair & { status: 'authenticated'; mfaEnrollmentRequired: boolean })
  | { status: 'mfa_required'; mfaToken: string; expiresIn: number };

interface Deps {
  db: DbHandles;
  passwords: PasswordHasher;
  tokens: TokenService;
  cipher: FieldCipher;
  audit: AuditService;
  metrics: Metrics;
  config: AppConfig;
  revocations: SessionRevocations;
}

export class AuthService {
  constructor(private readonly d: Deps) {}

  async register(input: RegisterInput, ctx: RequestCtx) {
    const passwordHash = await this.d.passwords.hash(input.password);
    const exists = await this.d.db.writer
      .selectFrom('users')
      .select('id')
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (exists) throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');

    const user = await withTransaction(this.d.db.writer, async (tx) => {
      const u = await tx
        .insertInto('users')
        .values({ email: input.email, password_hash: passwordHash, role: input.role })
        .returning(['id', 'email', 'role'])
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('profiles')
        .values({
          user_id: u.id,
          full_name: input.fullName,
          phone_enc: this.d.cipher.encryptNullable(input.phone, 'profiles.phone'),
          phone_bidx: input.phone ? blindIndex(this.d.config.BLIND_INDEX_KEY, input.phone) : null,
          dob_enc: null,
          gender: null,
          city: null,
          consent_version: CONSENT_VERSION,
          consent_given_at: new Date(),
        })
        .execute();
      await this.d.audit.record(
        { ...ctx, actor: null },
        {
          action: 'user.registered',
          resourceType: 'user',
          resourceId: u.id,
          actorId: u.id,
          metadata: { role: u.role },
        },
        tx,
      );
      return u;
    });
    this.d.metrics.authEvents.inc({ event: 'register', outcome: 'success' });
    return user;
  }

  async login(email: string, password: string, ctx: RequestCtx): Promise<LoginResult> {
    const user = await this.d.db.writer
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
    if (!user || user.status === 'deleted') {
      await this.d.passwords.verifyDummy(password);
      return this.failLogin(ctx, null, 'unknown_user');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      const retryAfter = Math.ceil((user.locked_until.getTime() - Date.now()) / 1000);
      await this.d.audit.recordSafe(ctx, {
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        actorId: user.id,
        outcome: 'denied',
        metadata: { reason: 'locked' },
      });
      throw Errors.locked('Account temporarily locked after repeated failed attempts', retryAfter);
    }
    if (!(await this.d.passwords.verify(user.password_hash, password))) {
      await this.registerFailure(user);
      return this.failLogin(ctx, user.id, 'bad_password');
    }
    if (user.status === 'suspended') {
      await this.d.audit.recordSafe(ctx, {
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        actorId: user.id,
        outcome: 'denied',
        metadata: { reason: 'suspended' },
      });
      throw Errors.forbidden('Account suspended', 'ACCOUNT_SUSPENDED');
    }
    if (this.d.passwords.needsRehash(user.password_hash)) {
      await this.d.db.writer
        .updateTable('users')
        .set({ password_hash: await this.d.passwords.hash(password) })
        .where('id', '=', user.id)
        .execute();
    }

    if (user.mfa_enabled) {
      const sid = crypto.randomUUID();
      const mfaToken = await this.d.tokens.signMfaChallenge({ sub: user.id, sid });
      this.d.metrics.authEvents.inc({ event: 'login', outcome: 'mfa_challenge' });
      return { status: 'mfa_required', mfaToken, expiresIn: this.d.config.MFA_CHALLENGE_TTL_SEC };
    }

    const pair = await this.completeLogin(user, ['pwd'], ctx);
    return { status: 'authenticated', ...pair, mfaEnrollmentRequired: MFA_REQUIRED_ROLES.has(user.role) };
  }

  async verifyMfaLogin(mfaToken: string, code: string, ctx: RequestCtx): Promise<LoginResult> {
    const challenge = await this.d.tokens.verifyMfaChallenge(mfaToken);
    if (!challenge) throw Errors.unauthorized('MFA challenge expired or invalid', 'INVALID_MFA_CHALLENGE');
    const user = await this.d.db.writer
      .selectFrom('users')
      .selectAll()
      .where('id', '=', challenge.sub)
      .executeTakeFirst();
    if (!user || user.status !== 'active' || !user.mfa_enabled || !user.mfa_secret_enc) {
      throw Errors.unauthorized('MFA challenge expired or invalid', 'INVALID_MFA_CHALLENGE');
    }
    if (user.locked_until && user.locked_until > new Date()) {
      throw Errors.locked(
        'Account temporarily locked',
        Math.ceil((user.locked_until.getTime() - Date.now()) / 1000),
      );
    }
    if (!(await this.checkTotp(user, code))) {
      await this.registerFailure(user);
      this.d.metrics.authEvents.inc({ event: 'mfa_verify', outcome: 'failure' });
      await this.d.audit.recordSafe(ctx, {
        action: 'auth.mfa_verify',
        resourceType: 'user',
        resourceId: user.id,
        actorId: user.id,
        outcome: 'failure',
      });
      throw Errors.unauthorized('Invalid verification code', 'INVALID_MFA_CODE');
    }
    const pair = await this.completeLogin(user, ['pwd', 'otp'], ctx);
    return { status: 'authenticated', ...pair, mfaEnrollmentRequired: false };
  }

  async refresh(refreshToken: string, ctx: RequestCtx): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    const outcome = await withTransaction(this.d.db.writer, async (tx) => {
      const row = await tx
        .selectFrom('refresh_tokens as rt')
        .innerJoin('users as u', 'u.id', 'rt.user_id')
        .select([
          'rt.id',
          'rt.user_id',
          'rt.family_id',
          'rt.expires_at',
          'rt.revoked_at',
          'rt.replaced_by',
          'u.role',
          'u.status',
          'u.mfa_enabled',
        ])
        .where('rt.token_hash', '=', hash)
        .forUpdate('rt')
        .executeTakeFirst();
      if (!row) return { kind: 'invalid' as const };
      if (row.revoked_at) {
        if (row.replaced_by) {
          // A rotated-out token was presented again: the token was stolen or replayed.
          // Kill the whole session family (OAuth 2.0 Security BCP, refresh token rotation).
          await tx
            .updateTable('refresh_tokens')
            .set({ revoked_at: new Date() })
            .where('family_id', '=', row.family_id)
            .where('revoked_at', 'is', null)
            .execute();
          await this.d.audit.record(
            ctx,
            {
              action: 'auth.refresh_reuse_detected',
              resourceType: 'session',
              resourceId: row.family_id,
              actorId: row.user_id,
              outcome: 'denied',
            },
            tx,
          );
          return { kind: 'reuse' as const };
        }
        return { kind: 'invalid' as const };
      }
      if (row.expires_at < new Date() || row.status !== 'active') return { kind: 'invalid' as const };

      const next = randomToken();
      const inserted = await tx
        .insertInto('refresh_tokens')
        .values({
          user_id: row.user_id,
          family_id: row.family_id,
          token_hash: sha256Hex(next),
          expires_at: new Date(Date.now() + this.d.config.REFRESH_TOKEN_TTL_SEC * 1000),
          ip: ctx.ip,
          user_agent: ctx.userAgent?.slice(0, 512) ?? null,
          revoked_at: null,
          replaced_by: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), replaced_by: inserted.id })
        .where('id', '=', row.id)
        .execute();
      // The session keeps the assurance level it was established with.
      const amr: AuthMethod[] = row.mfa_enabled ? ['pwd', 'otp'] : ['pwd'];
      const accessToken = await this.d.tokens.signAccess({
        sub: row.user_id,
        role: row.role,
        amr,
        sid: row.family_id,
      });
      return { kind: 'ok' as const, pair: this.pair(accessToken, next) };
    });

    if (outcome.kind !== 'ok') {
      this.d.metrics.authEvents.inc({ event: 'refresh', outcome: outcome.kind });
      throw Errors.unauthorized('Refresh token is invalid, expired or revoked', 'INVALID_REFRESH_TOKEN');
    }
    this.d.metrics.authEvents.inc({ event: 'refresh', outcome: 'success' });
    return outcome.pair;
  }

  async logout(refreshToken: string, ctx: RequestCtx): Promise<void> {
    const row = await this.d.db.writer
      .selectFrom('refresh_tokens')
      .select(['family_id', 'user_id'])
      .where('token_hash', '=', sha256Hex(refreshToken))
      .executeTakeFirst();
    if (!row) return;
    await this.d.revocations.revokeSessions([row.family_id]);
    await this.d.db.writer
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', row.family_id)
      .where('revoked_at', 'is', null)
      .execute();
    await this.d.audit.recordSafe(ctx, {
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: row.family_id,
      actorId: row.user_id,
    });
  }

  /**
   * Revokes every session: refresh tokens durably in Postgres, access tokens via Redis.
   * `mode: 'user'` also blocks any token issued up to now (suspension/deletion);
   * `mode: 'sessions'` kills only existing sessions so a replacement can be issued at once.
   */
  async revokeAllSessions(userId: string, mode: 'user' | 'sessions' = 'user'): Promise<void> {
    const families = await this.d.db.writer
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .returning('family_id')
      .execute();
    if (mode === 'user') await this.d.revocations.revokeUser(userId);
    await this.d.revocations.revokeSessions([...new Set(families.map((f) => f.family_id))]);
  }

  // ───────────────────────── MFA (TOTP, RFC 6238) ─────────────────────────

  async enrollMfa(userId: string, ctx: RequestCtx) {
    const user = await this.getUser(userId);
    if (user.mfa_enabled) throw Errors.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: this.d.config.MFA_ISSUER, label: user.email, secret });
    await this.d.db.writer
      .updateTable('users')
      .set({ mfa_secret_enc: this.d.cipher.encrypt(secret, MFA_AAD), mfa_last_timestep: null })
      .where('id', '=', userId)
      .execute();
    await this.d.audit.recordSafe(ctx, {
      action: 'auth.mfa_enrollment_started',
      resourceType: 'user',
      resourceId: userId,
    });
    return { secret, otpauthUrl, qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  /** Confirms enrolment with a first valid code; returns an MFA-elevated session. */
  async activateMfa(userId: string, sessionId: string, code: string, ctx: RequestCtx): Promise<TokenPair> {
    const user = await this.getUser(userId);
    if (user.mfa_enabled) throw Errors.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    if (!user.mfa_secret_enc) throw Errors.conflict('MFA_NOT_ENROLLED', 'Start MFA enrolment first');
    if (!(await this.checkTotp(user, code)))
      throw Errors.unauthorized('Invalid verification code', 'INVALID_MFA_CODE');
    await this.d.db.writer.updateTable('users').set({ mfa_enabled: true }).where('id', '=', userId).execute();
    // Old (password-only) sessions are revoked; the caller continues on a fresh MFA session.
    await this.revokeAllSessions(userId, 'sessions');
    await this.d.revocations.revokeSessions([sessionId]);
    await this.d.audit.recordSafe(ctx, {
      action: 'auth.mfa_enabled',
      resourceType: 'user',
      resourceId: userId,
      metadata: { previousSession: sessionId },
    });
    return this.completeLogin(user, ['pwd', 'otp'], ctx);
  }

  async disableMfa(userId: string, code: string, password: string, ctx: RequestCtx): Promise<void> {
    const user = await this.getUser(userId);
    if (MFA_REQUIRED_ROLES.has(user.role))
      throw Errors.forbidden('MFA is mandatory for this role', 'MFA_MANDATORY');
    if (!user.mfa_enabled) throw Errors.conflict('MFA_NOT_ENABLED', 'MFA is not enabled');
    const ok =
      (await this.d.passwords.verify(user.password_hash, password)) && (await this.checkTotp(user, code));
    if (!ok) throw Errors.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    await this.d.db.writer
      .updateTable('users')
      .set({ mfa_enabled: false, mfa_secret_enc: null, mfa_last_timestep: null })
      .where('id', '=', userId)
      .execute();
    await this.d.audit.recordSafe(ctx, {
      action: 'auth.mfa_disabled',
      resourceType: 'user',
      resourceId: userId,
    });
  }

  /** Verifies a TOTP code (±1 step drift) and rejects replays of an already-used time step. */
  private async checkTotp(user: User, code: string): Promise<boolean> {
    if (!user.mfa_secret_enc) return false;
    const secret = this.d.cipher.decrypt(user.mfa_secret_enc, MFA_AAD);
    const result = await verifyTotp({ secret, token: code, epochTolerance: 30 });
    if (!result.valid || !('timeStep' in result)) return false;
    const updated = await this.d.db.writer
      .updateTable('users')
      .set({ mfa_last_timestep: result.timeStep })
      .where('id', '=', user.id)
      .where((eb) =>
        eb.or([eb('mfa_last_timestep', 'is', null), eb('mfa_last_timestep', '<', String(result.timeStep))]),
      )
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  // ───────────────────────── helpers ─────────────────────────

  private async completeLogin(
    user: Pick<User, 'id' | 'role'>,
    amr: AuthMethod[],
    ctx: RequestCtx,
  ): Promise<TokenPair> {
    const familyId = crypto.randomUUID();
    const refreshToken = randomToken();
    await withTransaction(this.d.db.writer, async (tx) => {
      await tx
        .updateTable('users')
        .set({ failed_login_attempts: 0, locked_until: null, last_login_at: new Date() })
        .where('id', '=', user.id)
        .execute();
      await tx
        .insertInto('refresh_tokens')
        .values({
          user_id: user.id,
          family_id: familyId,
          token_hash: sha256Hex(refreshToken),
          expires_at: new Date(Date.now() + this.d.config.REFRESH_TOKEN_TTL_SEC * 1000),
          ip: ctx.ip,
          user_agent: ctx.userAgent?.slice(0, 512) ?? null,
          revoked_at: null,
          replaced_by: null,
        })
        .execute();
      await this.d.audit.record(
        ctx,
        {
          action: 'auth.login',
          resourceType: 'user',
          resourceId: user.id,
          actorId: user.id,
          metadata: { amr },
        },
        tx,
      );
    });
    this.d.metrics.authEvents.inc({ event: 'login', outcome: 'success' });
    const accessToken = await this.d.tokens.signAccess({
      sub: user.id,
      role: user.role as UserRole,
      amr,
      sid: familyId,
    });
    return this.pair(accessToken, refreshToken);
  }

  private pair(accessToken: string, refreshToken: string): TokenPair {
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: this.d.tokens.accessTtlSec };
  }

  private async registerFailure(user: User): Promise<void> {
    const attempts = user.failed_login_attempts + 1;
    const lock = attempts >= this.d.config.MAX_FAILED_LOGINS;
    await this.d.db.writer
      .updateTable('users')
      .set({
        failed_login_attempts: lock ? 0 : attempts,
        locked_until: lock
          ? new Date(Date.now() + this.d.config.LOCKOUT_MINUTES * 60_000)
          : user.locked_until,
      })
      .where('id', '=', user.id)
      .execute();
  }

  private async failLogin(ctx: RequestCtx, userId: string | null, reason: string): Promise<never> {
    this.d.metrics.authEvents.inc({ event: 'login', outcome: 'failure' });
    await this.d.audit.recordSafe(ctx, {
      action: 'auth.login',
      resourceType: 'user',
      resourceId: userId,
      actorId: userId,
      outcome: 'failure',
      metadata: { reason },
    });
    // Same response for unknown email and wrong password (no user enumeration).
    throw Errors.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  private async getUser(id: string): Promise<User> {
    const user = await this.d.db.writer
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user || user.status !== 'active') throw Errors.unauthorized();
    return user;
  }
}
