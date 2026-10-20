import { sql } from 'kysely';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Slot } from '../../db/types.js';
import type { Cache } from '../../infra/cache.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import type { AuditService } from '../audit/audit.service.js';
import { iso } from '../common/schemas.js';
import type { SlotDto } from './availability.schemas.js';

const MAX_WINDOW_DAYS = 14;
const MAX_SLOTS_PER_REQUEST = 500;
const PUBLIC_SLOTS_TTL_SEC = 15;

export const slotsCacheNs = (doctorId: string) => `slots:${doctorId}`;

export const toSlotDto = (s: Pick<Slot, 'id' | 'doctor_id' | 'starts_at' | 'ends_at' | 'status'>): SlotDto => ({
  id: s.id,
  doctorId: s.doctor_id,
  startsAt: iso(s.starts_at)!,
  endsAt: iso(s.ends_at)!,
  status: s.status,
});

interface Deps {
  db: DbHandles;
  cache: Cache;
  audit: AuditService;
}

function resolveWindow(from?: string, to?: string): { from: Date; to: Date } {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(start.getTime() + 7 * 86_400_000);
  if (end <= start) throw Errors.badRequest('INVALID_RANGE', '`to` must be after `from`');
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw Errors.badRequest('RANGE_TOO_LARGE', `Window may span at most ${MAX_WINDOW_DAYS} days`);
  }
  return { from: start, to: end };
}

export class AvailabilityService {
  constructor(private readonly d: Deps) {}

  /** Generates contiguous slots; overlapping ones are skipped by the EXCLUDE constraint. */
  async createSlots(doctorId: string, input: { from: string; to: string; slotMinutes: number }, ctx: RequestCtx) {
    const { from, to } = resolveWindow(input.from, input.to);
    if (from.getTime() < Date.now()) throw Errors.badRequest('PAST_SLOT', 'Slots must start in the future');
    const stepMs = input.slotMinutes * 60_000;
    const slots: { doctor_id: string; starts_at: Date; ends_at: Date }[] = [];
    for (let t = from.getTime(); t + stepMs <= to.getTime(); t += stepMs) {
      slots.push({ doctor_id: doctorId, starts_at: new Date(t), ends_at: new Date(t + stepMs) });
    }
    if (slots.length === 0) throw Errors.badRequest('EMPTY_WINDOW', 'Window is shorter than one slot');
    if (slots.length > MAX_SLOTS_PER_REQUEST) {
      throw Errors.badRequest('TOO_MANY_SLOTS', `At most ${MAX_SLOTS_PER_REQUEST} slots per request`);
    }

    const doctor = await this.d.db.writer.selectFrom('doctors').select('user_id').where('user_id', '=', doctorId).executeTakeFirst();
    if (!doctor) throw Errors.conflict('DOCTOR_PROFILE_MISSING', 'Create your doctor profile first');

    const created = await withTransaction(this.d.db.writer, async (tx) => {
      // ON CONFLICT DO NOTHING (no target) also covers exclusion-constraint violations.
      const rows = await tx.insertInto('availability_slots').values(slots).onConflict((oc) => oc.doNothing()).returning('id').execute();
      await this.d.audit.record(ctx, { action: 'slots.created', resourceType: 'doctor', resourceId: doctorId, metadata: { count: rows.length } }, tx);
      return rows.length;
    });
    await this.d.cache.invalidate(slotsCacheNs(doctorId));
    return { requested: slots.length, created, skippedOverlapping: slots.length - created };
  }

  async listOwnSlots(doctorId: string, range: { from?: string; to?: string }): Promise<SlotDto[]> {
    const { from, to } = resolveWindow(range.from, range.to);
    const rows = await this.d.db.writer
      .selectFrom('availability_slots')
      .select(['id', 'doctor_id', 'starts_at', 'ends_at', 'status'])
      .where('doctor_id', '=', doctorId)
      .where('starts_at', '>=', from)
      .where('starts_at', '<', to)
      .orderBy('starts_at')
      .execute();
    return rows.map(toSlotDto);
  }

  /** Public, bookable slots only. Cached briefly; booking itself never trusts the cache. */
  async listAvailable(doctorId: string, range: { from?: string; to?: string }): Promise<SlotDto[]> {
    const { from, to } = resolveWindow(range.from, range.to);
    const version = await this.d.cache.namespaceVersion(slotsCacheNs(doctorId));
    const key = `slots:${doctorId}:v${version}:${from.toISOString()}:${to.toISOString()}`;
    return this.d.cache.getOrSet('slots', key, PUBLIC_SLOTS_TTL_SEC, async () => {
      const rows = await this.d.db.reader
        .selectFrom('availability_slots as s')
        .innerJoin('doctors as d', 'd.user_id', 's.doctor_id')
        .select(['s.id', 's.doctor_id', 's.starts_at', 's.ends_at', 's.status'])
        .where('s.doctor_id', '=', doctorId)
        .where('d.verified_at', 'is not', null)
        .where('s.status', '=', 'available')
        .where('s.starts_at', '>', sql<Date>`now()`)
        .where('s.starts_at', '>=', from)
        .where('s.starts_at', '<', to)
        .orderBy('s.starts_at')
        .limit(500)
        .execute();
      return rows.map(toSlotDto);
    });
  }

  async setSlotStatus(doctorId: string, slotId: string, status: 'available' | 'blocked', ctx: RequestCtx): Promise<SlotDto> {
    const row = await withTransaction(this.d.db.writer, async (tx) => {
      const updated = await tx
        .updateTable('availability_slots')
        .set({ status, version: sql<number>`version + 1` })
        .where('id', '=', slotId)
        .where('doctor_id', '=', doctorId)
        .where('status', 'in', ['available', 'blocked'])
        .returning(['id', 'doctor_id', 'starts_at', 'ends_at', 'status'])
        .executeTakeFirst();
      if (!updated) return null;
      await this.d.audit.record(ctx, { action: `slot.${status === 'blocked' ? 'blocked' : 'unblocked'}`, resourceType: 'slot', resourceId: slotId }, tx);
      return updated;
    });
    if (!row) throw await this.slotError(doctorId, slotId);
    await this.d.cache.invalidate(slotsCacheNs(doctorId));
    return toSlotDto(row);
  }

  async deleteSlot(doctorId: string, slotId: string, ctx: RequestCtx): Promise<void> {
    const deleted = await withTransaction(this.d.db.writer, async (tx) => {
      const r = await tx
        .deleteFrom('availability_slots')
        .where('id', '=', slotId)
        .where('doctor_id', '=', doctorId)
        .where('status', 'in', ['available', 'blocked'])
        // Slots referenced by (even cancelled) consultations are kept for history.
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('consultations').select('id').where('slot_id', '=', slotId))))
        .returning('id')
        .executeTakeFirst();
      if (r) await this.d.audit.record(ctx, { action: 'slot.deleted', resourceType: 'slot', resourceId: slotId }, tx);
      return Boolean(r);
    });
    if (!deleted) throw await this.slotError(doctorId, slotId);
    await this.d.cache.invalidate(slotsCacheNs(doctorId));
  }

  private async slotError(doctorId: string, slotId: string) {
    const slot = await this.d.db.writer.selectFrom('availability_slots').select(['status', 'doctor_id']).where('id', '=', slotId).executeTakeFirst();
    if (!slot || slot.doctor_id !== doctorId) return Errors.notFound('Slot');
    return Errors.conflict('SLOT_NOT_MODIFIABLE', `Slot is ${slot.status} and cannot be modified`);
  }
}
