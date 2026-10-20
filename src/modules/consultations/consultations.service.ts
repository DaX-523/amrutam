import { sql } from 'kysely';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import {
  assertTransition,
  EARLY_START_MINUTES,
  NO_SHOW_GRACE_MINUTES,
} from '../../domain/consultation-state.js';
import type { Actor, RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Consultation, ConsultationStatus } from '../../db/types.js';
import type { Cache } from '../../infra/cache.js';
import type { FieldCipher } from '../../infra/crypto.js';
import { withTransaction, type DbHandles, type Tx } from '../../infra/db.js';
import type { Metrics } from '../../infra/metrics.js';
import { publishEvent } from '../../infra/outbox.js';
import type { AuditService } from '../audit/audit.service.js';
import { slotsCacheNs } from '../availability/availability.service.js';
import { decodeCursor, encodeCursor } from '../common/schemas.js';
import { CONSULTATION_AAD, toConsultationDto } from './consultations.mapper.js';
import type { ConsultationDto } from './consultations.schemas.js';

interface Deps {
  db: DbHandles;
  cipher: FieldCipher;
  audit: AuditService;
  cache: Cache;
  metrics: Metrics;
  config: AppConfig;
}

const CursorSchema = z.object({ t: z.string(), id: z.uuid() });

export class ConsultationsService {
  constructor(private readonly d: Deps) {}

  private detailQuery(db = this.d.db.writer) {
    return db
      .selectFrom('consultations as c')
      .leftJoin('profiles as pp', 'pp.user_id', 'c.patient_id')
      .leftJoin('doctors as dd', 'dd.user_id', 'c.doctor_id')
      .leftJoin('payments as pay', 'pay.consultation_id', 'c.id')
      .selectAll('c')
      .select([
        'pp.full_name as patient_name',
        'dd.display_name as doctor_name',
        'pay.status as payment_status',
      ]);
  }

  /** Ownership: patients see their own, doctors their assigned consultations. */
  private assertParticipant(actor: Actor, c: Pick<Consultation, 'patient_id' | 'doctor_id'>) {
    if (actor.id !== c.patient_id && actor.id !== c.doctor_id) {
      // 404 rather than 403: don't reveal that the resource exists (prevents IDOR probing).
      throw Errors.notFound('Consultation');
    }
  }

  async get(actor: Actor, id: string, ctx: RequestCtx): Promise<ConsultationDto> {
    const row = await this.detailQuery().where('c.id', '=', id).executeTakeFirst();
    if (!row) throw Errors.notFound('Consultation');
    try {
      this.assertParticipant(actor, row);
    } catch (err) {
      await this.d.audit.recordSafe(ctx, {
        action: 'consultation.read',
        resourceType: 'consultation',
        resourceId: id,
        outcome: 'denied',
      });
      throw err;
    }
    // PHI access is always audited.
    await this.d.audit.recordSafe(ctx, {
      action: 'consultation.read',
      resourceType: 'consultation',
      resourceId: id,
    });
    return toConsultationDto(row, this.d.cipher);
  }

  async list(actor: Actor, q: { status?: ConsultationStatus; cursor?: string; limit: number }) {
    const column = actor.role === 'doctor' ? 'c.doctor_id' : 'c.patient_id';
    let query = this.detailQuery(this.d.db.reader)
      .where(column, '=', actor.id)
      .orderBy('c.scheduled_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(q.limit + 1);
    if (q.status) query = query.where('c.status', '=', q.status);
    const cursor = decodeCursor(q.cursor, CursorSchema);
    if (q.cursor && !cursor) throw Errors.badRequest('INVALID_CURSOR', 'Malformed pagination cursor');
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('c.scheduled_at', '<', new Date(cursor.t)),
          eb.and([eb('c.scheduled_at', '=', new Date(cursor.t)), eb('c.id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await query.execute();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      // List view omits PHI (reason/notes); fetch a single consultation to read them (audited).
      items: page.map((r) => {
        const { reason: _r, notes: _n, ...rest } = toConsultationDto(r, null);
        return rest;
      }),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ t: new Date(last.scheduled_at).toISOString(), id: last.id })
          : null,
    };
  }

  async start(actor: Actor, id: string, expectedVersion: number | undefined, ctx: RequestCtx) {
    return this.transition(actor, id, 'in_progress', expectedVersion, ctx, {
      guard: (c) => {
        if (actor.id !== c.doctor_id) throw Errors.notFound('Consultation');
        if (Date.now() < new Date(c.scheduled_at).getTime() - EARLY_START_MINUTES * 60_000) {
          throw Errors.conflict(
            'TOO_EARLY',
            `Consultation can start at most ${EARLY_START_MINUTES} minutes early`,
          );
        }
      },
      set: () => ({ started_at: new Date() }),
    });
  }

  async complete(
    actor: Actor,
    id: string,
    notes: string,
    expectedVersion: number | undefined,
    ctx: RequestCtx,
  ) {
    return this.transition(actor, id, 'completed', expectedVersion, ctx, {
      guard: (c) => {
        if (actor.id !== c.doctor_id) throw Errors.notFound('Consultation');
      },
      set: () => ({
        completed_at: new Date(),
        notes_enc: this.d.cipher.encrypt(notes, CONSULTATION_AAD.notes),
      }),
      event: (c) => ({ type: 'consultation.completed', consultationId: c.id }),
    });
  }

  async markNoShow(actor: Actor, id: string, expectedVersion: number | undefined, ctx: RequestCtx) {
    return this.transition(actor, id, 'no_show', expectedVersion, ctx, {
      guard: (c) => {
        if (actor.id !== c.doctor_id) throw Errors.notFound('Consultation');
        if (Date.now() < new Date(c.scheduled_at).getTime() + NO_SHOW_GRACE_MINUTES * 60_000) {
          throw Errors.conflict(
            'TOO_EARLY',
            `No-show can be recorded ${NO_SHOW_GRACE_MINUTES} minutes after start time`,
          );
        }
      },
      set: () => ({}),
    });
  }

  /**
   * Cancellation (patient or doctor). Releases the slot and decides on a refund:
   * doctor-initiated -> always refund; patient -> refund if outside the policy window.
   */
  async cancel(
    actor: Actor,
    id: string,
    reason: string,
    expectedVersion: number | undefined,
    ctx: RequestCtx,
  ) {
    const current = await this.d.db.writer
      .selectFrom('consultations')
      .select(['slot_id', 'doctor_id', 'patient_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw Errors.notFound('Consultation');
    this.assertParticipant(actor, current);

    const result = await withTransaction(this.d.db.writer, async (tx) => {
      // Lock order: slot -> consultation -> payment (same as webhook & expiry job).
      await tx
        .selectFrom('availability_slots')
        .select('id')
        .where('id', '=', current.slot_id)
        .forUpdate()
        .execute();
      const c = await this.lockConsultation(tx, id, expectedVersion);
      assertTransition(c.status, 'cancelled');
      const payment = await tx
        .selectFrom('payments')
        .selectAll()
        .where('consultation_id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      const byDoctor = actor.id === c.doctor_id;
      const minutesToStart = (new Date(c.scheduled_at).getTime() - Date.now()) / 60_000;
      const refund =
        payment?.status === 'captured' &&
        (byDoctor || minutesToStart >= this.d.config.CANCELLATION_REFUND_WINDOW_MIN);

      const updated = await tx
        .updateTable('consultations')
        .set({
          status: 'cancelled',
          cancelled_at: new Date(),
          cancelled_by: actor.id,
          cancel_reason: reason,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (minutesToStart > 0) {
        // Freed future slot goes back on the market (doctor-cancelled slots get blocked).
        await tx
          .updateTable('availability_slots')
          .set({
            status: byDoctor ? 'blocked' : 'available',
            held_by: null,
            hold_expires_at: null,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', c.slot_id)
          .where('status', 'in', ['held', 'booked'])
          .execute();
      }
      if (payment?.status === 'initiated') {
        await tx
          .updateTable('payments')
          .set({ status: 'expired', failure_reason: 'cancelled_before_payment' })
          .where('id', '=', payment.id)
          .execute();
      } else if (refund && payment) {
        await tx
          .updateTable('payments')
          .set({ status: 'refund_pending' })
          .where('id', '=', payment.id)
          .execute();
        await publishEvent(
          tx,
          { type: 'payment', id: payment.id },
          { type: 'payment.refund_requested', paymentId: payment.id },
        );
      }
      await publishEvent(
        tx,
        { type: 'consultation', id },
        { type: 'consultation.cancelled', consultationId: id, refund },
      );
      await this.d.audit.record(
        ctx,
        {
          action: 'consultation.cancelled',
          resourceType: 'consultation',
          resourceId: id,
          metadata: { byRole: actor.role, refund, from: c.status },
        },
        tx,
      );
      return { from: c.status, doctorId: c.doctor_id, updated };
    });

    this.d.metrics.consultationTransitions.inc({ from: result.from, to: 'cancelled' });
    await this.d.cache.invalidate(slotsCacheNs(result.doctorId));
    return this.get(actor, id, ctx);
  }

  private async lockConsultation(tx: Tx, id: string, expectedVersion: number | undefined) {
    const c = await tx
      .selectFrom('consultations')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw Errors.notFound('Consultation');
    if (expectedVersion !== undefined && c.version !== expectedVersion) {
      throw Errors.conflict('VERSION_CONFLICT', 'Consultation was modified concurrently; reload and retry', {
        currentVersion: c.version,
      });
    }
    return c;
  }

  private async transition(
    actor: Actor,
    id: string,
    to: ConsultationStatus,
    expectedVersion: number | undefined,
    ctx: RequestCtx,
    spec: {
      guard: (c: Consultation) => void;
      set: (c: Consultation) => Record<string, unknown>;
      event?: (c: Consultation) => Parameters<typeof publishEvent>[2];
    },
  ): Promise<ConsultationDto> {
    const from = await withTransaction(this.d.db.writer, async (tx) => {
      const c = await this.lockConsultation(tx, id, expectedVersion);
      spec.guard(c);
      assertTransition(c.status, to);
      await tx
        .updateTable('consultations')
        .set({ ...spec.set(c), status: to, version: sql<number>`version + 1` })
        .where('id', '=', id)
        .where('version', '=', c.version)
        .execute();
      if (spec.event) await publishEvent(tx, { type: 'consultation', id }, spec.event(c));
      await this.d.audit.record(
        ctx,
        {
          action: `consultation.${to}`,
          resourceType: 'consultation',
          resourceId: id,
          metadata: { from: c.status },
        },
        tx,
      );
      return c.status;
    });
    this.d.metrics.consultationTransitions.inc({ from, to });
    return this.get(actor, id, ctx);
  }
}
