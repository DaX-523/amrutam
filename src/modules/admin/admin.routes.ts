import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Queues } from '../../infra/queue.js';
import { requestCtx } from '../../plugins/types.js';
import type { AuditService } from '../audit/audit.service.js';
import { UuidParam, errorResponses } from '../common/schemas.js';
import type { AdminService } from './admin.service.js';
import type { AnalyticsService } from './analytics.service.js';

const DateRange = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
});

export const adminRoutes =
  (deps: {
    admin: AdminService;
    audit: AuditService;
    analytics: AnalyticsService;
    queues: Queues;
  }): FastifyPluginAsyncZod =>
  async (app) => {
    const { admin, audit, analytics, queues } = deps;
    const security = [{ bearerAuth: [] }];

    app.get(
      '/doctors',
      {
        config: { permission: 'admin:doctors' },
        schema: {
          tags: ['Admin'],
          security,
          summary: 'List doctors (e.g. verification queue)',
          querystring: z.object({
            verified: z
              .enum(['true', 'false'])
              .transform((v) => v === 'true')
              .optional(),
            cursor: z.string().max(512).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          }),
          response: {
            200: z.object({
              items: z.array(z.record(z.string(), z.unknown())),
              nextCursor: z.string().nullable(),
            }),
            ...errorResponses,
          },
        },
      },
      async (req) => admin.listDoctors(req.query),
    );

    app.post(
      '/doctors/:id/verify',
      {
        config: { permission: 'admin:doctors' },
        schema: {
          tags: ['Admin'],
          security,
          summary: 'Verify a doctor (makes them discoverable/bookable)',
          params: UuidParam,
          response: { 200: z.object({ id: z.uuid(), verified: z.boolean() }), ...errorResponses },
        },
      },
      async (req) => admin.verifyDoctor(req.actor!.id, req.params.id, requestCtx(req)),
    );

    app.post(
      '/users/:id/status',
      {
        config: { permission: 'admin:users' },
        schema: {
          tags: ['Admin'],
          security,
          summary: 'Suspend / reactivate a user (suspension revokes all sessions)',
          params: UuidParam,
          body: z.object({ status: z.enum(['active', 'suspended']) }).strict(),
          response: { 200: z.object({ id: z.uuid(), status: z.string() }), ...errorResponses },
        },
      },
      async (req) => admin.setUserStatus(req.actor!.id, req.params.id, req.body.status, requestCtx(req)),
    );

    app.get(
      '/audit-logs',
      {
        config: { permission: 'admin:audit' },
        schema: {
          tags: ['Audit'],
          security,
          summary: 'Search the compliance audit trail',
          querystring: z.object({
            actorId: z.uuid().optional(),
            action: z.string().max(100).optional(),
            resourceType: z.string().max(50).optional(),
            resourceId: z.string().max(100).optional(),
            from: z.iso.datetime({ offset: true }).optional(),
            to: z.iso.datetime({ offset: true }).optional(),
            cursor: z.string().regex(/^\d+$/).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: {
            200: z.object({
              items: z.array(z.record(z.string(), z.unknown())),
              nextCursor: z.string().nullable(),
            }),
            ...errorResponses,
          },
        },
      },
      async (req) => {
        const q = req.query;
        const result = await audit.search({
          ...q,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
        });
        await audit.recordSafe(requestCtx(req), {
          action: 'audit.searched',
          resourceType: 'audit_log',
          metadata: { filters: Object.keys(q) },
        });
        return result;
      },
    );

    app.get(
      '/audit-logs/verify',
      {
        config: { permission: 'admin:audit' },
        schema: {
          tags: ['Audit'],
          security,
          summary: 'Verify audit hash-chain integrity (tamper detection)',
          querystring: z.object({ fromSeq: z.coerce.number().int().min(1).default(1) }),
          response: {
            200: z.object({
              valid: z.boolean(),
              checked: z.number().int(),
              firstInvalidSeq: z.string().nullable(),
              reason: z.string().nullable(),
            }),
            ...errorResponses,
          },
        },
      },
      async (req) => audit.verifyChain(req.query.fromSeq),
    );

    app.get(
      '/analytics/overview',
      {
        config: { permission: 'admin:analytics' },
        schema: {
          tags: ['Analytics'],
          security,
          summary: 'KPIs from daily rollups',
          querystring: DateRange,
          response: { 200: z.record(z.string(), z.unknown()), ...errorResponses },
        },
      },
      async (req) => analytics.overview(req.query.from, req.query.to),
    );

    app.post(
      '/analytics/refresh',
      {
        config: { permission: 'admin:analytics' },
        schema: {
          tags: ['Analytics'],
          security,
          summary: 'Recompute rollups for a date range (async job)',
          body: DateRange.strict(),
          response: { 202: z.object({ jobId: z.string(), status: z.literal('queued') }), ...errorResponses },
        },
      },
      async (req, reply) => {
        const job = await queues.maintenance.add('analytics-rollup', {
          from: req.body.from,
          to: req.body.to,
        });
        await audit.recordSafe(requestCtx(req), {
          action: 'analytics.refresh_requested',
          resourceType: 'analytics',
          metadata: req.body,
        });
        return reply.code(202).send({ jobId: String(job.id), status: 'queued' as const });
      },
    );
  };
