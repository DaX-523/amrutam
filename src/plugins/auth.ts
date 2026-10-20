import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { Errors } from '../domain/errors.js';
import { hasPermission, MFA_REQUIRED_ROLES } from '../domain/rbac-policy.js';
import type { TokenService } from '../infra/tokens.js';
import type { SessionRevocations } from '../modules/auth/session-revocations.js';
import './types.js';

/**
 * Authentication + coarse authorization for every /v1 route, deny-by-default:
 *  - routes are private unless `config.public` is set;
 *  - doctors/admins must have completed MFA (amr contains 'otp') unless `config.mfaExempt`;
 *  - `config.permission` is checked against the role matrix.
 * Ownership checks happen in the services.
 */
const authPlugin: FastifyPluginAsync<{ tokens: TokenService; revocations: SessionRevocations }> = async (
  app,
  { tokens, revocations },
) => {
  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (request) => {
    const url = request.routeOptions.url;
    if (!url?.startsWith('/v1')) return; // health, metrics, docs

    const header = request.headers.authorization;
    if (header) {
      const [scheme, token] = header.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) throw Errors.unauthorized('Malformed Authorization header');
      const claims = await tokens.verifyAccess(token);
      if (!claims || (await revocations.isRevoked(claims.sub, claims.iat ?? 0))) {
        throw Errors.unauthorized('Invalid or expired access token', 'INVALID_TOKEN');
      }
      request.actor = { id: claims.sub, role: claims.role, amr: claims.amr, sessionId: claims.sid };
    }

    const config = request.routeOptions.config;
    if (config.public) return;
    const actor = request.actor;
    if (!actor) throw Errors.unauthorized();
    if (MFA_REQUIRED_ROLES.has(actor.role) && !actor.amr.includes('otp') && !config.mfaExempt) {
      throw Errors.forbidden('Multi-factor authentication is required for this role', 'MFA_REQUIRED');
    }
    if (config.permission && !hasPermission(actor.role, config.permission)) {
      throw Errors.forbidden();
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
