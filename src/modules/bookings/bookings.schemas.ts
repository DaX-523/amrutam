import { z } from 'zod';
import { ConsultationSchema } from '../consultations/consultations.schemas.js';

export const CreateBookingBody = z
  .object({
    slotId: z.uuid(),
    reason: z.string().trim().min(3).max(1000).optional().describe('Chief complaint (encrypted at rest)'),
  })
  .strict();

export const BookingResponse = z
  .object({
    consultation: ConsultationSchema,
    payment: z.object({
      id: z.uuid(),
      status: z.string(),
      amountPaise: z.number().int(),
      currency: z.string(),
      provider: z.string(),
      orderId: z.string(),
    }),
    holdExpiresAt: z.string(),
  })
  .meta({ id: 'Booking' });

export type CreateBookingInput = z.infer<typeof CreateBookingBody>;
export type BookingDto = z.infer<typeof BookingResponse>;
