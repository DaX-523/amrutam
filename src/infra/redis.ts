import type { RedisOptions as BullRedisOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';

/**
 * General-purpose client (cache, rate limiting). Fails fast when Redis is unreachable
 * (no offline queue) so callers can fail open instead of piling up latency.
 */
export function createRedis(url: string, overrides: RedisOptions = {}): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectTimeout: 3_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    ...overrides,
  });
}

/** BullMQ requires blocking-capable connections with unlimited per-request retries. */
export function bullConnectionOptions(url: string): BullRedisOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}
