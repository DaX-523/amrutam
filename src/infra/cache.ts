import type { Redis } from 'ioredis';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

/**
 * Cache-aside helper.
 *  - Fail-open: Redis errors degrade to a DB read, never to a 5xx.
 *  - Single-flight: concurrent misses for the same key in this process share one load
 *    (stampede protection); TTL jitter spreads expiry across pods.
 *  - Versioned namespaces: invalidation is an O(1) INCR instead of a key scan.
 */
export class Cache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async getOrSet<T>(name: string, key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.redis.get(key);
      if (hit !== null) {
        this.metrics.cache.inc({ cache: name, result: 'hit' });
        return JSON.parse(hit) as T;
      }
    } catch (err) {
      this.metrics.cache.inc({ cache: name, result: 'error' });
      this.logger.warn({ err, key }, 'cache read failed; falling back to source');
      return load();
    }
    this.metrics.cache.inc({ cache: name, result: 'miss' });

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const promise = (async () => {
      const value = await load();
      const ttl = Math.max(1, Math.round(ttlSec * (0.9 + Math.random() * 0.2)));
      this.redis.set(key, JSON.stringify(value), 'EX', ttl).catch((err: unknown) => {
        this.logger.warn({ err, key }, 'cache write failed');
      });
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async namespaceVersion(ns: string): Promise<string> {
    try {
      return (await this.redis.get(`ver:${ns}`)) ?? '0';
    } catch {
      return 'nocache';
    }
  }

  async invalidate(ns: string): Promise<void> {
    try {
      await this.redis.incr(`ver:${ns}`);
    } catch (err) {
      // Entries expire via TTL anyway; correctness never depends on the cache.
      this.logger.warn({ err, ns }, 'cache invalidation failed');
    }
  }
}
