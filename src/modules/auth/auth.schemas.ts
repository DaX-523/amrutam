import { z } from 'zod';

const Email = z.email().max(254).transform((e) => e.toLowerCase());
// NIST 800-63B: length over composition rules; upper bound protects the hasher.
const Password = z.string().min(12, 'Password must be at least 12 characters').max(128);
const Otp = z.string().regex(/^\d{6}$/, 'Must be a 6-digit code');

export const RegisterBody = z
  .object({
    email: Email,
    password: Password,
    role: z.enum(['patient', 'doctor']).default('patient'),
    fullName: z.string().trim().min(2).max(120),
    phone: z
      .string()
      .regex(/^\+?[1-9]\d{7,14}$/, 'E.164 phone number expected')
      .optional(),
    consent: z.literal(true, { error: 'Consent to the privacy policy is required' }),
  })
  .strict();

export const LoginBody = z.object({ email: Email, password: z.string().min(1).max(128) }).strict();
export const MfaVerifyBody = z.object({ mfaToken: z.string().min(1).max(2048), code: Otp }).strict();
export const RefreshBody = z.object({ refreshToken: z.string().min(20).max(256) }).strict();
export const MfaCodeBody = z.object({ code: Otp }).strict();
export const MfaDisableBody = z.object({ code: Otp, password: z.string().min(1).max(128) }).strict();

export const TokenPair = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int(),
  })
  .meta({ id: 'TokenPair' });

export const LoginResponse = z
  .discriminatedUnion('status', [
    TokenPair.extend({ status: z.literal('authenticated'), mfaEnrollmentRequired: z.boolean() }),
    z.object({ status: z.literal('mfa_required'), mfaToken: z.string(), expiresIn: z.number().int() }),
  ])
  .meta({ id: 'LoginResponse' });

export const RegisterResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(['patient', 'doctor', 'admin']),
});

export const MfaEnrollResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrCodeDataUrl: z.string(),
});

export type RegisterInput = z.infer<typeof RegisterBody>;
