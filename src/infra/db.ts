import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from '../db/types.js';
import { retry } from '../lib/retry.js';
import type { Logger } from './logger.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight JS Dates.
pg.types.setTypeParser(1082, (v: string) => v);

export type DB = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface DbHandles {
  /** Primary: all writes and read-your-writes queries. */
  writer: DB;
  /** Replica (falls back to the primary locally): search, analytics, listings. */
  reader: DB;
  close(): Promise<void>;
}

export function createDb(opts: {
  url: string;
  readUrl?: string;
  poolMax: number;
  statementTimeoutMs: number;
  appName: string;
}): DbHandles {
  const makePool = (connectionString: string) =>
    new pg.Pool({
      connectionString,
      max: opts.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: opts.statementTimeoutMs,
      idle_in_transaction_session_timeout: 10_000,
      application_name: opts.appName,
    });
  const writer = new Kysely<Database>({ dialect: new PostgresDialect({ pool: makePool(opts.url) }) });
  const reader = opts.readUrl
    ? new Kysely<Database>({ dialect: new PostgresDialect({ pool: makePool(opts.readUrl) }) })
    : writer;
  return {
    writer,
    reader,
    async close() {
      await writer.destroy();
      if (reader !== writer) await reader.destroy();
    },
  };
}

/** SQLSTATEs that are safe to retry by re-running the whole transaction. */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01', '55P03']); // serialization, deadlock, lock_not_available

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

export function isRetryableDbError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

/**
 * Runs `fn` in a transaction, re-running it (with jittered backoff) on serialization
 * failures and deadlocks. `fn` must therefore be free of non-DB side effects.
 */
export async function withTransaction<T>(
  db: DB,
  fn: (tx: Tx) => Promise<T>,
  opts: { logger?: Logger; retries?: number } = {},
): Promise<T> {
  return retry(() => db.transaction().execute(fn), {
    retries: opts.retries ?? 3,
    baseMs: 20,
    maxMs: 500,
    isRetryable: isRetryableDbError,
    onRetry: (err, attempt, delay) =>
      opts.logger?.warn({ code: pgErrorCode(err), attempt, delay }, 'retrying transaction'),
  });
}
