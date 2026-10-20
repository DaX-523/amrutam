import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requestCtx } from '../../plugins/types.js';
import { UuidParam, errorResponses } from '../common/schemas.js';
import { CreatePrescriptionBody, PrescriptionSchema } from './prescriptions.schemas.js';
import type { PrescriptionsService } from './prescriptions.service.js';

/** Mounted under /v1/consultations — prescriptions are a sub-resource of a consultation. */
export const prescriptionsRoutes =
  ({ prescriptions }: { prescriptions: PrescriptionsService }): FastifyPluginAsyncZod =>
  async (app) => {
    const tags = ['Prescriptions'];
    const security = [{ bearerAuth: [] }];

    app.post(
      '/:id/prescription',
      {
        config: { permission: 'prescriptions:write' },
        schema: {
          tags,
          security,
          summary: 'Issue the prescription (treating doctor; PDF rendered asynchronously)',
          params: UuidParam,
          body: CreatePrescriptionBody,
          response: { 201: PrescriptionSchema, ...errorResponses },
        },
      },
      async (req, reply) =>
        reply
          .code(201)
          .send(await prescriptions.create(req.actor!, req.params.id, req.body, requestCtx(req))),
    );

    app.get(
      '/:id/prescription',
      {
        config: { permission: 'prescriptions:read_own' },
        schema: {
          tags,
          security,
          summary: 'Read prescription (audited PHI access)',
          params: UuidParam,
          response: { 200: PrescriptionSchema, ...errorResponses },
        },
      },
      async (req) => prescriptions.getForConsultation(req.actor!, req.params.id, requestCtx(req)),
    );

    app.get(
      '/:id/prescription/pdf',
      {
        config: { permission: 'prescriptions:read_own' },
        schema: {
          tags,
          security,
          summary: 'Download prescription PDF',
          params: UuidParam,
          produces: ['application/pdf'],
        },
      },
      async (req, reply) => {
        const pdf = await prescriptions.getPdf(req.actor!, req.params.id, requestCtx(req));
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="prescription-${req.params.id}.pdf"`)
          .header('cache-control', 'no-store')
          .send(pdf);
      },
    );
  };
