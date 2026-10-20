import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requestCtx } from '../../plugins/types.js';
import { errorResponses, ProblemSchema } from '../common/schemas.js';
import { BookingResponse, CreateBookingBody } from './bookings.schemas.js';
import type { BookingsService } from './bookings.service.js';

export const bookingsRoutes =
  ({ bookings, rateLimitMax }: { bookings: BookingsService; rateLimitMax: number }): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/',
      {
        config: { permission: 'bookings:create', rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } },
        schema: {
          tags: ['Bookings'],
          security: [{ bearerAuth: [] }],
          summary: 'Book a slot: holds it, creates a pending consultation and a payment order',
          description:
            'Idempotent via `Idempotency-Key`. Exactly one concurrent request can win a slot (409 SLOT_UNAVAILABLE for the rest). ' +
            'The hold expires after SLOT_HOLD_TTL_SEC unless the payment webhook confirms it.',
          body: CreateBookingBody,
          response: { 201: BookingResponse, 503: ProblemSchema, ...errorResponses },
        },
      },
      async (req, reply) =>
        reply.code(201).send(await bookings.book(req.actor!.id, req.body, requestCtx(req))),
    );
  };
