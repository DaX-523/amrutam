import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requestCtx } from '../../plugins/types.js';
import { UuidParam, errorResponses } from '../common/schemas.js';
import {
  CancelBody,
  CompleteBody,
  ConsultationListQuery,
  ConsultationListResponse,
  ConsultationSchema,
  TransitionBody,
} from './consultations.schemas.js';
import type { ConsultationsService } from './consultations.service.js';

export const consultationsRoutes =
  ({ consultations }: { consultations: ConsultationsService }): FastifyPluginAsyncZod =>
  async (app) => {
    const tags = ['Consultations'];
    const security = [{ bearerAuth: [] }];
    const one = { 200: ConsultationSchema, ...errorResponses };

    app.get(
      '/',
      {
        config: { permission: 'consultations:read_own' },
        schema: {
          tags,
          security,
          summary: 'List own consultations (PHI omitted)',
          querystring: ConsultationListQuery,
          response: { 200: ConsultationListResponse, ...errorResponses },
        },
      },
      async (req) => consultations.list(req.actor!, req.query),
    );

    app.get(
      '/:id',
      {
        config: { permission: 'consultations:read_own' },
        schema: {
          tags,
          security,
          summary: 'Consultation detail (PHI access is audited)',
          params: UuidParam,
          response: one,
        },
      },
      async (req) => consultations.get(req.actor!, req.params.id, requestCtx(req)),
    );

    app.post(
      '/:id/start',
      {
        config: { permission: 'consultations:conduct' },
        schema: {
          tags,
          security,
          summary: 'Doctor starts the consultation (confirmed -> in_progress)',
          params: UuidParam,
          body: TransitionBody,
          response: one,
        },
      },
      async (req) =>
        consultations.start(req.actor!, req.params.id, req.body.expectedVersion, requestCtx(req)),
    );

    app.post(
      '/:id/complete',
      {
        config: { permission: 'consultations:conduct' },
        schema: {
          tags,
          security,
          summary: 'Doctor completes with clinical notes (in_progress -> completed)',
          params: UuidParam,
          body: CompleteBody,
          response: one,
        },
      },
      async (req) =>
        consultations.complete(
          req.actor!,
          req.params.id,
          req.body.notes,
          req.body.expectedVersion,
          requestCtx(req),
        ),
    );

    app.post(
      '/:id/no-show',
      {
        config: { permission: 'consultations:conduct' },
        schema: {
          tags,
          security,
          summary: 'Doctor marks patient no-show',
          params: UuidParam,
          body: TransitionBody,
          response: one,
        },
      },
      async (req) =>
        consultations.markNoShow(req.actor!, req.params.id, req.body.expectedVersion, requestCtx(req)),
    );

    app.post(
      '/:id/cancel',
      {
        config: { permission: 'consultations:cancel_own' },
        schema: {
          tags,
          security,
          summary: 'Cancel (refund per policy, slot released)',
          params: UuidParam,
          body: CancelBody,
          response: one,
        },
      },
      async (req) =>
        consultations.cancel(
          req.actor!,
          req.params.id,
          req.body.reason,
          req.body.expectedVersion,
          requestCtx(req),
        ),
    );
  };
