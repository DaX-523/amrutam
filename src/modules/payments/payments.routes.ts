import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Errors } from '../../domain/errors.js';
import { requestCtx } from '../../plugins/types.js';
import { UuidParam, errorResponses } from '../common/schemas.js';
import { WEBHOOK_SIGNATURE_HEADER } from './gateway.js';
import type { PaymentsService } from './payments.service.js';

const PaymentSchema = z
  .object({
    id: z.uuid(),
    consultationId: z.uuid(),
    status: z.string(),
    amountPaise: z.number().int(),
    currency: z.string(),
    provider: z.string(),
    orderId: z.string().nullable(),
    capturedAt: z.string().nullable(),
    refundedAt: z.string().nullable(),
  })
  .meta({ id: 'Payment' });

export const paymentsRoutes =
  ({
    payments,
    mockCheckoutEnabled,
  }: {
    payments: PaymentsService;
    mockCheckoutEnabled: boolean;
  }): FastifyPluginAsyncZod =>
  async (app) => {
    const tags = ['Payments'];

    // Webhook needs the exact raw bytes for HMAC verification, so parse JSON as a string
    // in this encapsulated context only.
    await app.register(async (hook) => {
      hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
        done(null, body),
      );
      hook.post(
        '/webhook',
        {
          config: { public: true, idempotency: false, rateLimit: { max: 600, timeWindow: '1 minute' } },
          schema: {
            tags,
            summary: 'Payment provider webhook (HMAC-signed, de-duplicated by event id)',
            description: `Requires \`${WEBHOOK_SIGNATURE_HEADER}: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + rawBody)>\`; events older than 5 minutes are rejected.`,
            response: { 200: z.object({ outcome: z.string() }), ...errorResponses },
          },
        },
        async (req) => {
          const signature = req.headers[WEBHOOK_SIGNATURE_HEADER];
          return payments.handleWebhook(
            String(req.body ?? ''),
            typeof signature === 'string' ? signature : undefined,
            requestCtx(req),
          );
        },
      );
    });

    app.get(
      '/:id',
      {
        config: { permission: 'bookings:create' },
        schema: {
          tags,
          security: [{ bearerAuth: [] }],
          summary: 'Payment status (own)',
          params: UuidParam,
          response: { 200: PaymentSchema, ...errorResponses },
        },
      },
      async (req) => payments.getForPatient(req.actor!.id, req.params.id),
    );

    if (mockCheckoutEnabled) {
      app.post(
        '/:id/mock-checkout',
        {
          config: { permission: 'bookings:create' },
          schema: {
            tags,
            security: [{ bearerAuth: [] }],
            summary: 'DEV ONLY: simulate the provider checkout (sends a signed webhook)',
            params: UuidParam,
            body: z.object({ outcome: z.enum(['success', 'failure']).default('success') }).strict(),
            response: {
              200: z.object({ webhookStatus: z.number().int(), outcome: z.string() }),
              ...errorResponses,
            },
          },
        },
        async (req) => {
          const p = await payments.getForPatient(req.actor!.id, req.params.id);
          if (!p.orderId) throw Errors.conflict('ORDER_NOT_READY', 'Payment order not created yet');
          const { body, signature } = payments.buildMockWebhook(p.orderId, p.amountPaise, req.body.outcome);
          // Goes through the real HTTP pipeline: signature check, dedupe, saga step T3.
          const res = await app.inject({
            method: 'POST',
            url: '/v1/payments/webhook',
            headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: signature },
            payload: body,
          });
          const parsed = res.json<{ outcome?: string; code?: string }>();
          return { webhookStatus: res.statusCode, outcome: parsed.outcome ?? parsed.code ?? 'unknown' };
        },
      );
    }
  };
