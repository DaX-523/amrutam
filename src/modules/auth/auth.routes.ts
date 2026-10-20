import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestCtx } from '../../plugins/types.js';
import { errorResponses } from '../common/schemas.js';
import type { AuthService } from './auth.service.js';
import {
  LoginBody,
  LoginResponse,
  MfaCodeBody,
  MfaDisableBody,
  MfaEnrollResponse,
  MfaVerifyBody,
  RefreshBody,
  RegisterBody,
  RegisterResponse,
  TokenPair,
} from './auth.schemas.js';

export const authRoutes =
  (deps: { auth: AuthService; authRateLimitMax: number }): FastifyPluginAsyncZod =>
  async (app) => {
    const { auth } = deps;
    // Brute-force / credential-stuffing protection on top of account lockout.
    const strict = { rateLimit: { max: deps.authRateLimitMax, timeWindow: '1 minute' } };
    const tags = ['Auth'];

    app.post(
      '/register',
      {
        config: { public: true, ...strict },
        schema: {
          tags,
          summary: 'Register a patient or doctor account',
          body: RegisterBody,
          response: { 201: RegisterResponse, ...errorResponses },
        },
      },
      async (req, reply) => reply.code(201).send(await auth.register(req.body, requestCtx(req))),
    );

    // Auth endpoints are naturally idempotent or token-bound, so no Idempotency-Key is needed;
    // storing issued tokens in the idempotency table would also widen the blast radius of a DB leak.
    app.post(
      '/login',
      {
        config: { public: true, idempotency: false, ...strict },
        schema: {
          tags,
          summary: 'Password login (returns an MFA challenge when MFA is enabled)',
          body: LoginBody,
          response: { 200: LoginResponse, 423: errorResponses[401], ...errorResponses },
        },
      },
      async (req) => auth.login(req.body.email, req.body.password, requestCtx(req)),
    );

    app.post(
      '/mfa/verify',
      {
        config: { public: true, idempotency: false, ...strict },
        schema: { tags, summary: 'Complete login with a TOTP code', body: MfaVerifyBody, response: { 200: LoginResponse, ...errorResponses } },
      },
      async (req) => auth.verifyMfaLogin(req.body.mfaToken, req.body.code, requestCtx(req)),
    );

    app.post(
      '/refresh',
      {
        config: { public: true, idempotency: false, ...strict },
        schema: { tags, summary: 'Rotate refresh token', body: RefreshBody, response: { 200: TokenPair, ...errorResponses } },
      },
      async (req) => auth.refresh(req.body.refreshToken, requestCtx(req)),
    );

    app.post(
      '/logout',
      {
        config: { public: true, idempotency: false },
        schema: { tags, summary: 'Revoke the session (refresh token family)', body: RefreshBody, response: { 204: z.null(), ...errorResponses } },
      },
      async (req, reply) => {
        await auth.logout(req.body.refreshToken, requestCtx(req));
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/mfa/enroll',
      {
        config: { permission: 'mfa:manage_own', mfaExempt: true, idempotency: false },
        schema: {
          tags,
          summary: 'Start TOTP enrolment (returns secret + QR code)',
          security: [{ bearerAuth: [] }],
          response: { 200: MfaEnrollResponse, ...errorResponses },
        },
      },
      async (req) => auth.enrollMfa(req.actor!.id, requestCtx(req)),
    );

    app.post(
      '/mfa/activate',
      {
        config: { permission: 'mfa:manage_own', mfaExempt: true, idempotency: false, ...strict },
        schema: {
          tags,
          summary: 'Confirm TOTP enrolment; returns an MFA-elevated session',
          security: [{ bearerAuth: [] }],
          body: MfaCodeBody,
          response: { 200: TokenPair, ...errorResponses },
        },
      },
      async (req) => auth.activateMfa(req.actor!.id, req.actor!.sessionId, req.body.code, requestCtx(req)),
    );

    app.post(
      '/mfa/disable',
      {
        config: { permission: 'mfa:manage_own', idempotency: false, ...strict },
        schema: {
          tags,
          summary: 'Disable MFA (patients only)',
          security: [{ bearerAuth: [] }],
          body: MfaDisableBody,
          response: { 204: z.null(), ...errorResponses },
        },
      },
      async (req, reply) => {
        await auth.disableMfa(req.actor!.id, req.body.code, req.body.password, requestCtx(req));
        return reply.code(204).send(null);
      },
    );
  };
