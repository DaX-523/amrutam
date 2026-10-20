import type { Redis } from 'ioredis';
import type { Logger } from '../../infra/logger.js';

/**
 * Access tokens are stateless (15 min). To cut off a suspended/compromised user before
 * expiry, we store a per-user "revoked before <unix ts>" watermark in Redis for one access
 * TTL; the auth hook rejects tokens issued before it. Fails open if Redis is unavailable
 * (refresh tokens are still revoked durably in Postgres).
 */
export class SessionRevocations {
  constructor(
    private readonly redis: Redis,
    private readonly accessTtlSec: number,
    private readonly logger: Logger,
  ) {}

  async revokeUser(userId: string): Promise<void> {
    try {
      await this.redis.set(`revoked:user:${userId}`, Math.floor(Date.now() / 1000), 'EX', this.accessTtlSec + 60);
    } catch (err) {
      this.logger.error({ err, userId }, 'failed to record access-token revocation');
    }
  }

  async isRevoked(userId: string, issuedAt: number): Promise<boolean> {
    try {
      const watermark = await this.redis.get(`revoked:user:${userId}`);
      return watermark !== null && issuedAt < Number(watermark);
    } catch {
      return false;
    }
  }
}
