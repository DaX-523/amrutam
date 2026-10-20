import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestCtx } from '../../plugins/types.js';
import { errorResponses } from '../common/schemas.js';
import {
  CreateSlotsBody,
  CreateSlotsResponse,
  DoctorSlotParams,
  SlotIdParams,
  SlotRangeQuery,
  SlotSchema,
  UpdateSlotBody,
} from './availability.schemas.js';
import type { AvailabilityService } from './availability.service.js';

/** Mounted under /v1/doctors. */
export const availabilityRoutes =
  ({ availability }: { availability: AvailabilityService }): FastifyPluginAsyncZod =>
  async (app) => {
    const tags = ['Availability'];
    const security = [{ bearerAuth: [] }];

    app.get(
      '/:id/slots',
      {
        config: { public: true },
        schema: {
          tags,
          summary: 'Bookable slots of a doctor',
          params: DoctorSlotParams,
          querystring: SlotRangeQuery,
          response: { 200: z.array(SlotSchema), ...errorResponses },
        },
      },
      async (req) => availability.listAvailable(req.params.id, req.query),
    );

    app.post(
      '/me/slots',
      {
        config: { permission: 'slots:manage_own' },
        schema: {
          tags,
          security,
          summary: 'Publish availability (generates contiguous slots)',
          body: CreateSlotsBody,
          response: { 201: CreateSlotsResponse, ...errorResponses },
        },
      },
      async (req, reply) =>
        reply.code(201).send(await availability.createSlots(req.actor!.id, req.body, requestCtx(req))),
    );

    app.get(
      '/me/slots',
      {
        config: { permission: 'slots:manage_own' },
        schema: {
          tags,
          security,
          summary: 'Own slots in all states',
          querystring: SlotRangeQuery,
          response: { 200: z.array(SlotSchema), ...errorResponses },
        },
      },
      async (req) => availability.listOwnSlots(req.actor!.id, req.query),
    );

    app.patch(
      '/me/slots/:slotId',
      {
        config: { permission: 'slots:manage_own' },
        schema: {
          tags,
          security,
          summary: 'Block / unblock a free slot',
          params: SlotIdParams,
          body: UpdateSlotBody,
          response: { 200: SlotSchema, ...errorResponses },
        },
      },
      async (req) =>
        availability.setSlotStatus(req.actor!.id, req.params.slotId, req.body.status, requestCtx(req)),
    );

    app.delete(
      '/me/slots/:slotId',
      {
        config: { permission: 'slots:manage_own' },
        schema: {
          tags,
          security,
          summary: 'Delete a free slot',
          params: SlotIdParams,
          response: { 204: z.null(), ...errorResponses },
        },
      },
      async (req, reply) => {
        await availability.deleteSlot(req.actor!.id, req.params.slotId, requestCtx(req));
        return reply.code(204).send(null);
      },
    );
  };
