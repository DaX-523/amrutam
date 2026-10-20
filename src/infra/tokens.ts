import { errors, jwtVerify, SignJWT, decodeProtectedHeader } from 'jose';
import type { UserRole } from '../db/types.js';

export type AuthMethod = 'pwd' | 'otp';

export interface AccessClaims {
  sub: string;
  role: UserRole;
  /** Authentication methods used; doctors/admins need 'otp' for anything but MFA enrolment. */
  amr: AuthMethod[];
  /** Refresh-token family (session) id, lets us correlate and revoke sessions. */
  sid: string;
  /** Issued-at (unix seconds), set on verification. */
  iat?: number;
}

export interface MfaChallengeClaims {
  sub: string;
  sid: string;
}

type TokenType = 'access' | 'mfa_challenge';

/**
 * HS256 JWTs with a keyring + `kid` header: rotate by adding a new key, switching
 * JWT_ACTIVE_KID, and removing the old key after one access-token TTL.
 */
export class TokenService {
  constructor(
    private readonly opts: {
      keys: ReadonlyMap<string, Buffer>;
      activeKid: string;
      issuer: string;
      audience: string;
      accessTtlSec: number;
      mfaChallengeTtlSec: number;
    },
  ) {}

  private sign(type: TokenType, claims: Record<string, unknown>, sub: string, ttlSec: number) {
    const key = this.opts.keys.get(this.opts.activeKid)!;
    return new SignJWT({ ...claims, typ: type })
      .setProtectedHeader({ alg: 'HS256', kid: this.opts.activeKid })
      .setSubject(sub)
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .setJti(crypto.randomUUID())
      .sign(key);
  }

  signAccess(c: AccessClaims): Promise<string> {
    return this.sign('access', { role: c.role, amr: c.amr, sid: c.sid }, c.sub, this.opts.accessTtlSec);
  }

  signMfaChallenge(c: MfaChallengeClaims): Promise<string> {
    return this.sign('mfa_challenge', { sid: c.sid }, c.sub, this.opts.mfaChallengeTtlSec);
  }

  get accessTtlSec() {
    return this.opts.accessTtlSec;
  }

  private async verify(token: string, type: TokenType) {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      return null;
    }
    const key = kid ? this.opts.keys.get(kid) : undefined;
    if (!key) return null;
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: this.opts.issuer,
        audience: this.opts.audience,
      });
      if (payload.typ !== type || typeof payload.sub !== 'string') return null;
      return payload;
    } catch (err) {
      if (err instanceof errors.JOSEError) return null;
      throw err;
    }
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    const p = await this.verify(token, 'access');
    if (!p) return null;
    return { sub: p.sub!, role: p.role as UserRole, amr: (p.amr as AuthMethod[]) ?? [], sid: String(p.sid), iat: p.iat ?? 0 };
  }

  async verifyMfaChallenge(token: string): Promise<MfaChallengeClaims | null> {
    const p = await this.verify(token, 'mfa_challenge');
    return p ? { sub: p.sub!, sid: String(p.sid) } : null;
  }
}
