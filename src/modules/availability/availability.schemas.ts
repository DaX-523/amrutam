import { z } from 'zod';

export const SlotSchema = z
  .object({
    id: z.uuid(),
    doctorId: z.uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
    status: z.enum(['available', 'held', 'booked', 'blocked']),
  })
  .meta({ id: 'Slot' });

export const CreateSlotsBody = z
  .object({
    from: z.iso.datetime({ offset: true }).describe('Start of the availability window (ISO 8601)'),
    to: z.iso.datetime({ offset: true }).describe('End of the availability window (ISO 8601)'),
    slotMinutes: z.number().int().min(10).max(120).default(15),
  })
  .strict();

export const SlotRangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const UpdateSlotBody = z.object({ status: z.enum(['available', 'blocked']) }).strict();

export const DoctorSlotParams = z.object({ id: z.uuid() });
export const SlotIdParams = z.object({ slotId: z.uuid() });

export const CreateSlotsResponse = z.object({ requested: z.number().int(), created: z.number().int(), skippedOverlapping: z.number().int() });

export type SlotDto = z.infer<typeof SlotSchema>;
