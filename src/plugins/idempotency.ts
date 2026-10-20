import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { AppError, Errors } from '../domain/errors.js';
import { canonicalJson, sha256Hex, type FieldCipher } from '../infra/crypto.js';
import type { DB } from '../infra/db.js';
import type { Logger } from '../infra/logger.js';
import type { Metrics } from '../infra/metrics.js';
import './types.js';

/**
 * Idempotency for every mutating /v1 call (Stripe-style semantics):
 *
 *  - `Idempotency-Key` header is REQUIRED on POST/PUT/PATCH/DELETE (unless opted out).
 *  - Keys are scoped per user (or "anon" for unauthenticated routes) and stored durably
 *    in Postgres, with a fingerprint of method + route + params + body.
 *  - First request: row inserted as `in_progress` (lease), handler runs, the response is
 *    stored (encrypted, it may contain PHI) and the row becomes `completed`.
 *  - Retry with the same key + same payload  -> stored response replayed verbatim
 *    (`Idempotent-Replayed: true`), handler NOT executed again.
 *  - Same key + different payload              -> 422 IDEMPOTENCY_KEY_REUSED.
 *  - Same key while the first is still running -> 409 IDEMPOTENCY_REQUEST_IN_PROGRESS.
 *  - 5xx responses release the key so the client can safely retry; a crashed request's
 *    lease expires after LEASE_SECONDS and can be taken over.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const LEASE_SECONDS = 30;
/** Status codes that don't represent an executed request and must not be cached. */
const NOT_STORED = new Set([401, 403, 429]);

const idempotencyPlugin: FastifyPluginAsync<{
  db: DB;
  cipher: FieldCipher;
  metrics: Metrics;
  logger: Logger;
  ttlHours: number;
}> = async (app, { db, cipher, metrics, logger, ttlHours }) => {
  app.decorateRequest('idempotency', null);
  const aad = 'idempotency_keys.response_body';

  app.addHook('preHandler', async (request, reply) => {
    const url = request.routeOptions.url;
    if (!url?.startsWith('/v1') || !MUTATING.has(request.method)) return;
    if (request.routeOptions.config.idempotency === false) return;

    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw Errors.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'A valid Idempotency-Key header (8-128 chars, [A-Za-z0-9_-:.]) is required for this operation',
      );
    }
    const scope = request.actor ? `user:${request.actor.id}` : 'anon';
    const requestHash = sha256Hex(
      canonicalJson({ m: request.method, u: url, p: request.params, q: request.query, b: request.body }),
    );

    const inserted = await db
      .insertInto('idempotency_keys')
      .values({
        scope,
        key,
        method: request.method,
        path: url,
        request_hash: requestHash,
        status: 'in_progress',
        locked_until: sql<Date>`now() + make_interval(secs => ${LEASE_SECONDS})`,
        expires_at: sql<Date>`now() + make_interval(hours => ${ttlHours})`,
      })
      .onConflict((oc) => oc.columns(['scope', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();

    if (inserted) {
      request.idempotency = { scope, key };
      metrics.idempotency.inc({ result: 'new' });
      return;
    }

    const existing = await db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('scope', '=', scope)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!existing) {
      // Row expired and was purged between the two statements; ask the client to retry.
      throw Errors.conflict('IDEMPOTENCY_REQUEST_IN_PROGRESS', 'Please retry the request');
    }
    if (existing.request_hash !== requestHash) {
      metrics.idempotency.inc({ result: 'mismatch' });
      throw Errors.unprocessable(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request payload',
      );
    }
    if (existing.status === 'completed') {
      metrics.idempotency.inc({ result: 'replayed' });
      reply
        .code(existing.response_status ?? 200)
        .header('idempotent-replayed', 'true')
        .header('content-type', 'application/json; charset=utf-8');
      const body = existing.response_body ? cipher.decrypt(existing.response_body, aad) : '';
      return reply.send(body ? JSON.parse(body) : undefined);
    }

    // In progress: take over only if the previous holder's lease has expired (crash).
    const takeover = await db
      .updateTable('idempotency_keys')
      .set({ locked_until: sql<Date>`now() + make_interval(secs => ${LEASE_SECONDS})` })
      .where('scope', '=', scope)
      .where('key', '=', key)
      .where('status', '=', 'in_progress')
      .where('locked_until', '<', sql<Date>`now()`)
      .returning('key')
      .executeTakeFirst();
    if (takeover) {
      request.idempotency = { scope, key };
      metrics.idempotency.inc({ result: 'takeover' });
      return;
    }
    metrics.idempotency.inc({ result: 'in_progress' });
    throw new AppError(
      409,
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed',
      undefined,
      { 'retry-after': '1' },
    );
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const idem = request.idempotency;
    if (!idem) return payload;
    request.idempotency = null;
    try {
      if (reply.statusCode >= 500 || NOT_STORED.has(reply.statusCode)) {
        await db.deleteFrom('idempotency_keys').where('scope', '=', idem.scope).where('key', '=', idem.key).execute();
      } else {
        const body = typeof payload === 'string' ? payload : payload == null ? '' : null;
        await db
          .updateTable('idempotency_keys')
          .set({
            status: 'completed',
            response_status: reply.statusCode,
            response_body: body ? cipher.encrypt(body, aad) : null,
          })
          .where('scope', '=', idem.scope)
          .where('key', '=', idem.key)
          .execute();
      }
    } catch (err) {
      // The lease will expire and allow a retry; never fail the actual response.
      logger.error({ err }, 'failed to persist idempotency result');
    }
    return payload;
  });
};

export default fp(idempotencyPlugin, { name: 'idempotency' });
