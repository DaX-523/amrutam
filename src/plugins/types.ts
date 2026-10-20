import type { Actor, RequestCtx } from '../domain/context.js';
import type { Permission } from '../domain/rbac-policy.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    idempotency: { scope: string; key: string } | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without a token (a token, if sent, is still verified). */
    public?: boolean;
    /** Required RBAC permission. Omitted on a non-public route = any authenticated user. */
    permission?: Permission;
    /** Allows doctors/admins without completed MFA (only MFA enrolment routes). */
    mfaExempt?: boolean;
    /** Set false to opt a mutating route out of Idempotency-Key enforcement. */
    idempotency?: boolean;
  }
}

export function requestCtx(req: {
  id: string;
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  actor: Actor | null;
}): RequestCtx {
  const ua = req.headers['user-agent'];
  const traceparent = req.headers.traceparent;
  const traceId = typeof traceparent === 'string' ? (traceparent.split('-')[1] ?? null) : null;
  return {
    requestId: req.id,
    ip: req.ip || null,
    userAgent: typeof ua === 'string' ? ua : null,
    traceId,
    actor: req.actor,
  };
}
