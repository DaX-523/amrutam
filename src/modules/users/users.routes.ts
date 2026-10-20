import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestCtx } from '../../plugins/types.js';
import { errorResponses } from '../common/schemas.js';
import { DeleteAccountBody, MeResponse, UpdateProfileBody } from './users.schemas.js';
import type { UsersService } from './users.service.js';

export const usersRoutes =
  ({ users }: { users: UsersService }): FastifyPluginAsyncZod =>
  async (app) => {
    const tags = ['Me'];
    const security = [{ bearerAuth: [] }];

    app.get(
      '/',
      {
        config: { mfaExempt: true },
        schema: {
          tags,
          security,
          summary: 'Current user and profile',
          response: { 200: MeResponse, ...errorResponses },
        },
      },
      async (req) => users.getMe(req.actor!.id),
    );

    app.patch(
      '/profile',
      {
        config: { permission: 'profile:manage_own' },
        schema: {
          tags,
          security,
          summary: 'Update own profile (PHI fields are encrypted at rest)',
          body: UpdateProfileBody,
          response: { 200: MeResponse, ...errorResponses },
        },
      },
      async (req) => users.updateProfile(req.actor!.id, req.body, requestCtx(req)),
    );

    app.get(
      '/export',
      {
        config: { permission: 'data:export_own', rateLimit: { max: 5, timeWindow: '1 hour' } },
        schema: {
          tags,
          security,
          summary: 'Export all personal data (DPDP right of access)',
          response: { 200: z.record(z.string(), z.unknown()), ...errorResponses },
        },
      },
      async (req) => users.exportData(req.actor!.id, requestCtx(req)),
    );

    app.delete(
      '/',
      {
        config: { permission: 'profile:manage_own' },
        schema: {
          tags,
          security,
          summary: 'Delete account (erasure; clinical records retained per law)',
          body: DeleteAccountBody,
          response: { 204: z.null(), ...errorResponses },
        },
      },
      async (req, reply) => {
        await users.deleteAccount(req.actor!.id, req.body.password, requestCtx(req));
        return reply.code(204).send(null);
      },
    );
  };
