import { z } from 'zod';

const Tag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,40}$/, 'lowercase slug expected');

export const UpsertDoctorProfileBody = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    registrationNumber: z.string().trim().min(4).max(40),
    specialties: z.array(Tag).min(1).max(10),
    languages: z.array(Tag).max(10).default([]),
    qualifications: z.array(z.string().trim().min(2).max(80)).max(10).default([]),
    yearsExperience: z.number().int().min(0).max(70),
    feePaise: z.number().int().min(100).max(10_000_000),
    city: z.string().trim().min(2).max(80).optional(),
    bio: z.string().trim().max(2000).optional(),
  })
  .strict();

export const DoctorSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    specialties: z.array(z.string()),
    languages: z.array(z.string()),
    qualifications: z.array(z.string()),
    yearsExperience: z.number().int(),
    feePaise: z.number().int(),
    city: z.string().nullable(),
    bio: z.string().nullable(),
    rating: z.number(),
    ratingCount: z.number().int(),
    verified: z.boolean(),
    nextAvailableAt: z.string().nullable(),
  })
  .meta({ id: 'Doctor' });

export const SearchDoctorsQuery = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  specialty: Tag.optional(),
  language: Tag.optional(),
  city: z.string().trim().min(2).max(80).optional(),
  minFee: z.coerce.number().int().min(0).optional(),
  maxFee: z.coerce.number().int().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  availableOn: z.iso.date().optional().describe('YYYY-MM-DD in the clinic timezone (Asia/Kolkata)'),
  sort: z.enum(['relevance', 'rating', 'fee', 'experience']).default('relevance'),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const SearchDoctorsResponse = z.object({
  items: z.array(DoctorSchema),
  nextCursor: z.string().nullable(),
});

export type UpsertDoctorProfileInput = z.infer<typeof UpsertDoctorProfileBody>;
export type SearchDoctorsInput = z.infer<typeof SearchDoctorsQuery>;
export type DoctorDto = z.infer<typeof DoctorSchema>;
