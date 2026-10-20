import type { UserRole } from '../db/types.js';
import type { AuthMethod } from '../infra/tokens.js';

export interface Actor {
  id: string;
  role: UserRole;
  amr: AuthMethod[];
  sessionId: string;
}

/** Per-request metadata passed into services for auditing and authorization. */
export interface RequestCtx {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  actor: Actor | null;
}

export const systemCtx = (requestId: string): RequestCtx => ({
  requestId,
  ip: null,
  userAgent: null,
  traceId: null,
  actor: null,
});
