import type { Redis } from 'ioredis';
import type { Logger } from '../../infra/logger.js';

/**
 * Access tokens are stateless (15 min). Two short-lived Redis denylists (TTL = one access
 * token lifetime) let us cut them off before expiry:
 *  - per user: "reject tokens issued at or before T" (suspension, account deletion);
 *  - per session id: exact session kill (logout, MFA activation replacing a weaker session).
 * Checked with a single MGET per request. Fails open if Redis is unavailable (refresh tokens
 * are still revoked durably in Postgres, so exposure is bounded by the access-token TTL).
 */
export class SessionRevocations {
  constructor(
    private readonly redis: Redis,
    private readonly accessTtlSec: number,
    private readonly logger: Logger,
  ) {}

  private get ttl() {
    return this.accessTtlSec + 60;
  }

  async revokeUser(userId: string): Promise<void> {
    try {
      await this.redis.set(`revoked:user:${userId}`, Math.floor(Date.now() / 1000), 'EX', this.ttl);
    } catch (err) {
      this.logger.error({ err, userId }, 'failed to record user access-token revocation');
    }
  }

  async revokeSessions(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    try {
      const pipeline = this.redis.multi();
      for (const sid of sessionIds) pipeline.set(`revoked:sid:${sid}`, '1', 'EX', this.ttl);
      await pipeline.exec();
    } catch (err) {
      this.logger.error({ err }, 'failed to record session revocation');
    }
  }

  async isRevoked(userId: string, sessionId: string, issuedAt: number): Promise<boolean> {
    try {
      const [userWatermark, session] = await this.redis.mget(
        `revoked:user:${userId}`,
        `revoked:sid:${sessionId}`,
      );
      return session !== null || (userWatermark !== null && issuedAt <= Number(userWatermark));
    } catch {
      return false;
    }
  }
}
