import { z } from 'zod';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Cache } from '../../infra/cache.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthService } from '../auth/auth.service.js';
import { decodeCursor, encodeCursor, iso } from '../common/schemas.js';
import { DOCTORS_CACHE_NS } from '../doctors/doctors.service.js';

const CursorSchema = z.object({ t: z.string(), id: z.uuid() });

export class AdminService {
  constructor(private readonly d: { db: DbHandles; audit: AuditService; auth: AuthService; cache: Cache }) {}

  async listDoctors(q: { verified?: boolean; cursor?: string; limit: number }) {
    let query = this.d.db.reader
      .selectFrom('doctors as d')
      .innerJoin('users as u', 'u.id', 'd.user_id')
      .select([
        'd.user_id',
        'd.display_name',
        'd.registration_number',
        'd.specialties',
        'd.city',
        'd.verified_at',
        'd.created_at',
        'u.email',
        'u.status',
        'u.mfa_enabled',
      ])
      .orderBy('d.created_at', 'desc')
      .orderBy('d.user_id', 'desc')
      .limit(q.limit + 1);
    if (q.verified === true) query = query.where('d.verified_at', 'is not', null);
    if (q.verified === false) query = query.where('d.verified_at', 'is', null);
    const cursor = decodeCursor(q.cursor, CursorSchema);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('d.created_at', '<', new Date(cursor.t)),
          eb.and([eb('d.created_at', '=', new Date(cursor.t)), eb('d.user_id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.user_id,
        displayName: r.display_name,
        email: r.email,
        registrationNumber: r.registration_number,
        specialties: r.specialties,
        city: r.city,
        status: r.status,
        mfaEnabled: r.mfa_enabled,
        verifiedAt: iso(r.verified_at),
        createdAt: iso(r.created_at)!,
      })),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.user_id })
          : null,
    };
  }

  async verifyDoctor(adminId: string, doctorId: string, ctx: RequestCtx) {
    const updated = await withTransaction(this.d.db.writer, async (tx) => {
      const r = await tx
        .updateTable('doctors')
        .set({ verified_at: new Date(), verified_by: adminId })
        .where('user_id', '=', doctorId)
        .where('verified_at', 'is', null)
        .returning('user_id')
        .executeTakeFirst();
      if (r)
        await this.d.audit.record(
          ctx,
          { action: 'admin.doctor_verified', resourceType: 'doctor', resourceId: doctorId },
          tx,
        );
      return r;
    });
    if (!updated) {
      const exists = await this.d.db.writer
        .selectFrom('doctors')
        .select('verified_at')
        .where('user_id', '=', doctorId)
        .executeTakeFirst();
      if (!exists) throw Errors.notFound('Doctor');
      throw Errors.conflict('ALREADY_VERIFIED', 'Doctor is already verified');
    }
    await this.d.cache.invalidate(DOCTORS_CACHE_NS);
    return { id: doctorId, verified: true };
  }

  async setUserStatus(adminId: string, userId: string, status: 'active' | 'suspended', ctx: RequestCtx) {
    if (adminId === userId)
      throw Errors.conflict('SELF_MODIFICATION', 'Admins cannot change their own status');
    const r = await withTransaction(this.d.db.writer, async (tx) => {
      const u = await tx
        .updateTable('users')
        .set({ status })
        .where('id', '=', userId)
        .where('status', '!=', 'deleted')
        .returning(['id', 'role'])
        .executeTakeFirst();
      if (u)
        await this.d.audit.record(
          ctx,
          {
            action: status === 'suspended' ? 'admin.user_suspended' : 'admin.user_reactivated',
            resourceType: 'user',
            resourceId: userId,
          },
          tx,
        );
      return u;
    });
    if (!r) throw Errors.notFound('User');
    if (status === 'suspended') await this.d.auth.revokeAllSessions(userId);
    if (r.role === 'doctor') await this.d.cache.invalidate(DOCTORS_CACHE_NS);
    return { id: userId, status };
  }
}
