import { sql } from 'kysely';
import type { AppConfig } from '../../config/env.js';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Cache } from '../../infra/cache.js';
import type { FieldCipher } from '../../infra/crypto.js';
import { withTransaction, type DbHandles, type Tx } from '../../infra/db.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics.js';
import { publishEvent } from '../../infra/outbox.js';
import type { AuditService } from '../audit/audit.service.js';
import { slotsCacheNs } from '../availability/availability.service.js';
import { iso } from '../common/schemas.js';
import { CONSULTATION_AAD, toConsultationDto } from '../consultations/consultations.mapper.js';
import type { PaymentGateway } from '../payments/gateway.js';
import type { BookingDto, CreateBookingInput } from './bookings.schemas.js';

/** Anti-hoarding: a patient may hold at most this many unpaid slots at once. */
export const MAX_ACTIVE_HOLDS_PER_PATIENT = 3;

interface Deps {
  db: DbHandles;
  cipher: FieldCipher;
  audit: AuditService;
  gateway: PaymentGateway;
  cache: Cache;
  metrics: Metrics;
  logger: Logger;
  config: AppConfig;
}

/**
 * Booking saga (orchestrated):
 *
 *  T1 (local ACID tx)  hold slot (atomic conditional UPDATE) + consultation(pending_payment)
 *                      + payment(initiated) + outbox(booking.held) + audit
 *  T2 (remote)         create provider order (idempotency key = payment id; retried, circuit-broken)
 *  T3 (async)          provider webhook -> confirm (see PaymentsService.handleWebhook)
 *
 *  Compensations: T2 failure -> C1 cancel consultation, release slot, fail payment.
 *                 No webhook before hold expiry -> hold-expiry job releases slot, expires payment.
 *                 Late capture after release -> automatic refund.
 */
export class BookingsService {
  constructor(private readonly d: Deps) {}

  async book(patientId: string, input: CreateBookingInput, ctx: RequestCtx): Promise<BookingDto> {
    const { config } = this.d;

    // ── T1: reserve ──────────────────────────────────────────────────────────
    const reserved = await withTransaction(this.d.db.writer, async (tx) => {
      const activeHolds = await tx
        .selectFrom('consultations')
        .select(sql<string>`count(*)`.as('n'))
        .where('patient_id', '=', patientId)
        .where('status', '=', 'pending_payment')
        .executeTakeFirstOrThrow();
      if (Number(activeHolds.n) >= MAX_ACTIVE_HOLDS_PER_PATIENT) {
        return {
          error: Errors.conflict('TOO_MANY_PENDING_BOOKINGS', 'Complete or cancel pending bookings first'),
        };
      }

      // The single statement that decides who wins a slot. Row-level lock + predicate
      // re-check means exactly one concurrent caller can flip available -> held.
      const slot = await tx
        .updateTable('availability_slots as s')
        .set({
          status: 'held',
          held_by: patientId,
          hold_expires_at: sql<Date>`now() + make_interval(secs => ${config.SLOT_HOLD_TTL_SEC})`,
          version: sql<number>`s.version + 1`,
        })
        .from('doctors as d')
        .whereRef('d.user_id', '=', 's.doctor_id')
        .where('s.id', '=', input.slotId)
        .where('s.status', '=', 'available')
        .where('s.starts_at', '>', sql<Date>`now() + make_interval(mins => ${config.MIN_BOOKING_LEAD_MIN})`)
        .where('d.verified_at', 'is not', null)
        .where('d.user_id', '!=', patientId)
        .returning([
          's.id',
          's.doctor_id',
          's.starts_at',
          's.ends_at',
          's.hold_expires_at',
          'd.fee_paise',
          'd.display_name',
        ])
        .executeTakeFirst();
      // Diagnose on the SAME connection: borrowing a second pool connection while holding one
      // starves the pool under contention (found by the 50-way race test).
      if (!slot) return { error: await this.unavailableReason(tx, input.slotId) };

      const consultation = await tx
        .insertInto('consultations')
        .values({
          patient_id: patientId,
          doctor_id: slot.doctor_id,
          slot_id: slot.id,
          status: 'pending_payment',
          scheduled_at: slot.starts_at,
          ends_at: slot.ends_at,
          fee_paise: slot.fee_paise,
          reason_enc: this.d.cipher.encryptNullable(input.reason, CONSULTATION_AAD.reason),
          notes_enc: null,
          started_at: null,
          completed_at: null,
          cancelled_at: null,
          cancelled_by: null,
          cancel_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const payment = await tx
        .insertInto('payments')
        .values({
          consultation_id: consultation.id,
          patient_id: patientId,
          amount_paise: slot.fee_paise,
          provider: this.d.gateway.name,
          provider_order_id: null,
          provider_payment_id: null,
          provider_refund_id: null,
          failure_reason: null,
          captured_at: null,
          refunded_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await publishEvent(
        tx,
        { type: 'consultation', id: consultation.id },
        { type: 'booking.held', consultationId: consultation.id },
      );
      await this.d.audit.record(
        ctx,
        {
          action: 'booking.created',
          resourceType: 'consultation',
          resourceId: consultation.id,
          metadata: { slotId: slot.id, doctorId: slot.doctor_id },
        },
        tx,
      );
      return { slot, consultation, payment };
    });

    if ('error' in reserved) {
      this.d.metrics.bookings.inc({ outcome: 'slot_unavailable' });
      throw reserved.error;
    }
    const { slot, consultation, payment } = reserved;
    await this.d.cache.invalidate(slotsCacheNs(slot.doctor_id));

    // ── T2: remote side effect, outside any DB transaction ───────────────────
    let orderId: string;
    try {
      ({ orderId } = await this.d.gateway.createOrder({
        amountPaise: payment.amount_paise,
        currency: payment.currency,
        receipt: payment.id,
        idempotencyKey: payment.id,
      }));
    } catch (err) {
      this.d.logger.error(
        { err, consultationId: consultation.id },
        'payment order creation failed; compensating',
      );
      await this.compensateReservation(
        consultation.id,
        slot.id,
        patientId,
        'payment_gateway_unavailable',
        ctx,
      );
      this.d.metrics.bookings.inc({ outcome: 'gateway_failed' });
      throw Errors.unavailable(
        'PAYMENT_GATEWAY_UNAVAILABLE',
        'Payment provider unavailable, please retry shortly',
        10,
      );
    }

    await this.d.db.writer
      .updateTable('payments')
      .set({ provider_order_id: orderId })
      .where('id', '=', payment.id)
      .execute();
    this.d.metrics.bookings.inc({ outcome: 'held' });

    return {
      consultation: toConsultationDto(
        { ...consultation, doctor_name: slot.display_name, payment_status: payment.status },
        this.d.cipher,
      ),
      payment: {
        id: payment.id,
        status: payment.status,
        amountPaise: payment.amount_paise,
        currency: payment.currency,
        provider: payment.provider,
        orderId,
      },
      holdExpiresAt: iso(slot.hold_expires_at)!,
    };
  }

  /** C1: semantic rollback of T1. Lock order: slot -> consultation -> payment. */
  private async compensateReservation(
    consultationId: string,
    slotId: string,
    patientId: string,
    reason: string,
    ctx: RequestCtx,
  ) {
    await withTransaction(this.d.db.writer, async (tx) => {
      await tx
        .updateTable('availability_slots')
        .set({ status: 'available', held_by: null, hold_expires_at: null, version: sql<number>`version + 1` })
        .where('id', '=', slotId)
        .where('status', '=', 'held')
        .where('held_by', '=', patientId)
        .execute();
      await tx
        .updateTable('consultations')
        .set({
          status: 'cancelled',
          cancelled_at: new Date(),
          cancel_reason: reason,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', consultationId)
        .where('status', '=', 'pending_payment')
        .execute();
      await tx
        .updateTable('payments')
        .set({ status: 'failed', failure_reason: reason })
        .where('consultation_id', '=', consultationId)
        .where('status', '=', 'initiated')
        .execute();
      await this.d.audit.record(
        ctx,
        {
          action: 'booking.compensated',
          resourceType: 'consultation',
          resourceId: consultationId,
          outcome: 'failure',
          metadata: { reason },
        },
        tx,
      );
    });
  }

  private async unavailableReason(tx: Tx, slotId: string) {
    const s = await tx
      .selectFrom('availability_slots as s')
      .innerJoin('doctors as d', 'd.user_id', 's.doctor_id')
      .select(['s.status', 's.starts_at', 'd.verified_at'])
      .where('s.id', '=', slotId)
      .executeTakeFirst();
    if (!s || !s.verified_at) return Errors.notFound('Slot');
    if (s.status !== 'available')
      return Errors.conflict('SLOT_UNAVAILABLE', 'This slot has just been taken; please pick another');
    return Errors.conflict('SLOT_TOO_SOON', 'This slot starts too soon to be booked');
  }
}
