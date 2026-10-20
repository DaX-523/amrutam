import type { AppConfig } from '../../config/env.js';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import { blindIndex, type FieldCipher } from '../../infra/crypto.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import type { PasswordHasher } from '../../infra/passwords.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthService } from '../auth/auth.service.js';
import { iso } from '../common/schemas.js';
import type { UpdateProfileInput } from './users.schemas.js';

interface Deps {
  db: DbHandles;
  cipher: FieldCipher;
  audit: AuditService;
  auth: AuthService;
  passwords: PasswordHasher;
  config: AppConfig;
}

export class UsersService {
  constructor(private readonly d: Deps) {}

  async getMe(userId: string) {
    const row = await this.d.db.writer
      .selectFrom('users as u')
      .innerJoin('profiles as p', 'p.user_id', 'u.id')
      .select([
        'u.id',
        'u.email',
        'u.role',
        'u.status',
        'u.mfa_enabled',
        'u.created_at',
        'p.full_name',
        'p.phone_enc',
        'p.dob_enc',
        'p.gender',
        'p.city',
        'p.consent_version',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!row) throw Errors.notFound('User');
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      mfaEnabled: row.mfa_enabled,
      createdAt: iso(row.created_at)!,
      profile: {
        fullName: row.full_name,
        phone: this.d.cipher.decryptNullable(row.phone_enc, 'profiles.phone'),
        dateOfBirth: this.d.cipher.decryptNullable(row.dob_enc, 'profiles.dob'),
        gender: row.gender,
        city: row.city,
        consentVersion: row.consent_version,
      },
    };
  }

  async updateProfile(userId: string, input: UpdateProfileInput, ctx: RequestCtx) {
    const set: Record<string, unknown> = {};
    if (input.fullName !== undefined) set.full_name = input.fullName;
    if (input.gender !== undefined) set.gender = input.gender;
    if (input.city !== undefined) set.city = input.city;
    if (input.phone !== undefined) {
      set.phone_enc = this.d.cipher.encryptNullable(input.phone, 'profiles.phone');
      set.phone_bidx = input.phone ? blindIndex(this.d.config.BLIND_INDEX_KEY, input.phone) : null;
    }
    if (input.dateOfBirth !== undefined)
      set.dob_enc = this.d.cipher.encryptNullable(input.dateOfBirth, 'profiles.dob');
    if (Object.keys(set).length) {
      await withTransaction(this.d.db.writer, async (tx) => {
        await tx.updateTable('profiles').set(set).where('user_id', '=', userId).execute();
        // Field names only, never values.
        await this.d.audit.record(
          ctx,
          {
            action: 'profile.updated',
            resourceType: 'profile',
            resourceId: userId,
            metadata: { fields: Object.keys(input) },
          },
          tx,
        );
      });
    }
    return this.getMe(userId);
  }

  /** Right of access (DPDP Act 2023 / GDPR Art. 15): everything we hold about the caller. */
  async exportData(userId: string, ctx: RequestCtx) {
    const me = await this.getMe(userId);
    const db = this.d.db.writer;
    const consultations = await db
      .selectFrom('consultations')
      .selectAll()
      .where((eb) => eb.or([eb('patient_id', '=', userId), eb('doctor_id', '=', userId)]))
      .orderBy('scheduled_at', 'desc')
      .execute();
    const prescriptions = await db
      .selectFrom('prescriptions')
      .selectAll()
      .where((eb) => eb.or([eb('patient_id', '=', userId), eb('doctor_id', '=', userId)]))
      .execute();
    const payments = await db
      .selectFrom('payments')
      .select(['id', 'consultation_id', 'amount_paise', 'currency', 'status', 'created_at'])
      .where('patient_id', '=', userId)
      .execute();
    await this.d.audit.record(ctx, { action: 'data.exported', resourceType: 'user', resourceId: userId });
    const c = this.d.cipher;
    return {
      generatedAt: new Date().toISOString(),
      account: me,
      consultations: consultations.map((x) => ({
        id: x.id,
        role: x.patient_id === userId ? 'patient' : 'doctor',
        status: x.status,
        scheduledAt: iso(x.scheduled_at),
        reason: c.decryptNullable(x.reason_enc, 'consultations.reason'),
        notes: c.decryptNullable(x.notes_enc, 'consultations.notes'),
      })),
      prescriptions: prescriptions.map((p) => ({
        id: p.id,
        consultationId: p.consultation_id,
        items: c.decryptJson<unknown>(p.items_enc, 'prescriptions.items'),
        advice: c.decryptNullable(p.advice_enc, 'prescriptions.advice'),
        createdAt: iso(p.created_at),
      })),
      payments: payments.map((p) => ({ ...p, created_at: iso(p.created_at) })),
    };
  }

  /**
   * Right to erasure, balanced with medical-record retention law: the account and
   * identifying profile data are scrubbed; clinical records stay (pseudonymous) for the
   * statutory retention period.
   */
  async deleteAccount(userId: string, password: string, ctx: RequestCtx): Promise<void> {
    const user = await this.d.db.writer
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (!(await this.d.passwords.verify(user.password_hash, password))) {
      throw Errors.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }
    const upcoming = await this.d.db.writer
      .selectFrom('consultations')
      .select('id')
      .where((eb) => eb.or([eb('patient_id', '=', userId), eb('doctor_id', '=', userId)]))
      .where('status', 'in', ['pending_payment', 'confirmed', 'in_progress'])
      .executeTakeFirst();
    if (upcoming)
      throw Errors.conflict('ACTIVE_CONSULTATIONS', 'Cancel or complete active consultations first');

    await withTransaction(this.d.db.writer, async (tx) => {
      await tx
        .updateTable('users')
        .set({
          status: 'deleted',
          email: `deleted+${userId}@invalid.local`,
          password_hash: '!',
          mfa_enabled: false,
          mfa_secret_enc: null,
          deleted_at: new Date(),
        })
        .where('id', '=', userId)
        .execute();
      await tx
        .updateTable('profiles')
        .set({ full_name: 'Deleted user', phone_enc: null, phone_bidx: null, dob_enc: null, city: null })
        .where('user_id', '=', userId)
        .execute();
      await tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();
      await this.d.audit.record(
        ctx,
        { action: 'user.deleted', resourceType: 'user', resourceId: userId },
        tx,
      );
    });
    await this.d.auth.revokeAllSessions(userId);
  }
}
