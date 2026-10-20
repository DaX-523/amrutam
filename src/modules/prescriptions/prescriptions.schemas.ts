import { z } from 'zod';

export const PrescriptionItem = z
  .object({
    medicine: z.string().trim().min(2).max(200),
    dosage: z.string().trim().min(1).max(100).describe('e.g. "500 mg", "1 tsp"'),
    frequency: z.string().trim().min(1).max(100).describe('e.g. "twice daily after meals"'),
    durationDays: z.number().int().min(1).max(365),
    instructions: z.string().trim().max(500).optional(),
  })
  .strict();

export const CreatePrescriptionBody = z
  .object({
    items: z.array(PrescriptionItem).min(1).max(30),
    advice: z.string().trim().max(5000).optional().describe('Diet / lifestyle (pathya-apathya) advice'),
    followUpDate: z.iso.date().optional(),
  })
  .strict();

export const PrescriptionSchema = z
  .object({
    id: z.uuid(),
    consultationId: z.uuid(),
    doctorId: z.uuid(),
    patientId: z.uuid(),
    items: z.array(PrescriptionItem),
    advice: z.string().nullable(),
    followUpDate: z.string().nullable(),
    contentHash: z.string().describe('SHA-256 of the canonical prescription content (integrity)'),
    pdfStatus: z.enum(['pending', 'ready', 'failed']),
    createdAt: z.string(),
  })
  .meta({ id: 'Prescription' });

export type CreatePrescriptionInput = z.infer<typeof CreatePrescriptionBody>;
export type PrescriptionItemDto = z.infer<typeof PrescriptionItem>;
