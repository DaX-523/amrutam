import { sql } from 'kysely';
import type { RequestCtx } from '../../domain/context.js';
import type { DB, Tx } from '../../infra/db.js';
import type { Logger } from '../../infra/logger.js';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  metadata?: Record<string, unknown>;
  /** Overrides ctx.actor (e.g. failed login where the actor is not authenticated). */
  actorId?: string | null;
}

export interface AuditQuery {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

/**
 * Compliance audit trail. Records who did what to which resource, from where, and the
 * outcome — including PHI reads. Never put PHI itself in `metadata`.
 * Hash-chaining and immutability are enforced by the database (migration 0002).
 */
export class AuditService {
  constructor(
    private readonly deps: { db: DB; logger: Logger },
  ) {}

  /**
   * Pass `tx` to make the audit record atomic with the state change it describes.
   * Call it last in the transaction: it briefly locks the chain head.
   */
  async record(ctx: RequestCtx, entry: AuditEntry, tx?: Tx): Promise<void> {
    const executor = tx ?? this.deps.db;
    await executor
      .insertInto('audit_logs')
      .values({
        actor_id: entry.actorId !== undefined ? entry.actorId : (ctx.actor?.id ?? null),
        actor_role: ctx.actor?.role ?? null,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId ?? null,
        outcome: entry.outcome ?? 'success',
        ip: ctx.ip,
        user_agent: ctx.userAgent?.slice(0, 512) ?? null,
        request_id: ctx.requestId,
        trace_id: ctx.traceId,
        metadata: JSON.stringify(entry.metadata ?? {}),
      })
      .execute();
  }

  /** Best-effort variant for read-path auditing; failures are logged, never surfaced. */
  async recordSafe(ctx: RequestCtx, entry: AuditEntry): Promise<void> {
    try {
      await this.record(ctx, entry);
    } catch (err) {
      this.deps.logger.error({ err, action: entry.action }, 'audit write failed');
    }
  }

  async search(q: AuditQuery) {
    let query = this.deps.db
      .selectFrom('audit_logs')
      .select([
        'id',
        'chain_seq',
        'occurred_at',
        'actor_id',
        'actor_role',
        'action',
        'resource_type',
        'resource_id',
        'outcome',
        'ip',
        'request_id',
        'trace_id',
        'metadata',
        'hash',
      ])
      .orderBy('chain_seq', 'desc')
      .limit(q.limit + 1);
    if (q.actorId) query = query.where('actor_id', '=', q.actorId);
    if (q.action) query = query.where('action', '=', q.action);
    if (q.resourceType) query = query.where('resource_type', '=', q.resourceType);
    if (q.resourceId) query = query.where('resource_id', '=', q.resourceId);
    if (q.from) query = query.where('occurred_at', '>=', q.from);
    if (q.to) query = query.where('occurred_at', '<', q.to);
    if (q.cursor) query = query.where('chain_seq', '<', q.cursor);
    const rows = await query.execute();
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return { items, nextCursor: hasMore ? items[items.length - 1]!.chain_seq : null };
  }

  /**
   * Walks the hash chain in append order and recomputes every hash. Detects edited rows
   * (hash mismatch), deleted rows (sequence gap / broken prev link) and re-ordering.
   */
  async verifyChain(fromSeq = 1, limit = 100_000) {
    const result = await sql<{
      checked: string;
      first_bad_seq: string | null;
      reason: string | null;
    }>`
      WITH chain AS (
        SELECT chain_seq, prev_hash, hash,
               audit_canonical(prev_hash, occurred_at, actor_id, action, resource_type,
                               resource_id, outcome, metadata) AS recomputed,
               lag(hash) OVER (ORDER BY chain_seq) AS expected_prev,
               lag(chain_seq) OVER (ORDER BY chain_seq) AS prev_seq
        FROM audit_logs
        WHERE chain_seq >= ${fromSeq}
        ORDER BY chain_seq
        LIMIT ${limit}
      ), problems AS (
        SELECT chain_seq,
               CASE
                 WHEN hash <> recomputed THEN 'hash_mismatch'
                 WHEN prev_seq IS NOT NULL AND chain_seq <> prev_seq + 1 THEN 'sequence_gap'
                 WHEN prev_seq IS NOT NULL AND prev_hash IS DISTINCT FROM expected_prev THEN 'broken_link'
               END AS reason
        FROM chain
      )
      SELECT (SELECT count(*) FROM chain)::text AS checked,
             (SELECT chain_seq FROM problems WHERE reason IS NOT NULL ORDER BY chain_seq LIMIT 1)::text AS first_bad_seq,
             (SELECT reason FROM problems WHERE reason IS NOT NULL ORDER BY chain_seq LIMIT 1) AS reason
    `.execute(this.deps.db);
    const row = result.rows[0]!;
    return {
      valid: row.first_bad_seq === null,
      checked: Number(row.checked),
      firstInvalidSeq: row.first_bad_seq,
      reason: row.reason,
    };
  }
}
