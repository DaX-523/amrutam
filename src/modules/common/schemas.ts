import { z } from 'zod';

export const UuidParam = z.object({ id: z.uuid() });

export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string(),
    requestId: z.string(),
    errors: z.unknown().optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 7807 problem details' });

/** Standard error responses attached to every route for the OpenAPI document. */
export const errorResponses = {
  400: ProblemSchema,
  401: ProblemSchema,
  403: ProblemSchema,
  404: ProblemSchema,
  409: ProblemSchema,
  422: ProblemSchema,
  429: ProblemSchema,
} as const;

export const CursorQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

/** Opaque keyset cursor: base64url(JSON). Never trust its content beyond typing. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
