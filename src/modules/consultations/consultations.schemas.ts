import { z } from 'zod';

export const ConsultationStatusEnum = z.enum(['pending_payment', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show']);

export const ConsultationSchema = z
  .object({
    id: z.uuid(),
    status: ConsultationStatusEnum,
    patientId: z.uuid(),
    patientName: z.string().nullable(),
    doctorId: z.uuid(),
    doctorName: z.string().nullable(),
    slotId: z.uuid(),
    scheduledAt: z.string(),
    endsAt: z.string(),
    feePaise: z.number().int(),
    reason: z.string().nullable(),
    notes: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelReason: z.string().nullable(),
    paymentStatus: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Consultation' });

export const ConsultationListQuery = z.object({
  status: ConsultationStatusEnum.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const ConsultationListResponse = z.object({
  items: z.array(ConsultationSchema.omit({ reason: true, notes: true })),
  nextCursor: z.string().nullable(),
});

/** Optimistic concurrency: clients may send the version they last saw. */
export const TransitionBody = z.object({ expectedVersion: z.number().int().min(0).optional() }).strict();
export const CompleteBody = TransitionBody.extend({ notes: z.string().trim().min(1).max(10_000) }).strict();
export const CancelBody = TransitionBody.extend({ reason: z.string().trim().min(3).max(500) }).strict();

export type ConsultationDto = z.infer<typeof ConsultationSchema>;
