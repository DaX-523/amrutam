import { z } from 'zod';

export const MeResponse = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: z.enum(['patient', 'doctor', 'admin']),
    status: z.string(),
    mfaEnabled: z.boolean(),
    createdAt: z.string(),
    profile: z.object({
      fullName: z.string(),
      phone: z.string().nullable(),
      dateOfBirth: z.string().nullable(),
      gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullable(),
      city: z.string().nullable(),
      consentVersion: z.string().nullable(),
    }),
  })
  .meta({ id: 'Me' });

export const UpdateProfileBody = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{7,14}$/)
      .nullable()
      .optional(),
    dateOfBirth: z.iso.date().nullable().optional(),
    gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullable().optional(),
    city: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

export const DeleteAccountBody = z.object({ password: z.string().min(1).max(128) }).strict();

export type UpdateProfileInput = z.infer<typeof UpdateProfileBody>;
