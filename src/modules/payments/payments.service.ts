import { sql } from 'kysely';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Cache } from '../../infra/cache.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics.js';
import { publishEvent } from '../../infra/outbox.js';
import type { AuditService } from '../audit/audit.service.js';
import { slotsCacheNs } from '../availability/availability.service.js';
import { iso } from '../common/schemas.js';
import { signWebhook, verifyWebhookSignature, type PaymentGateway } from './gateway.js';

export const WebhookEvent = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['payment.captured', 'payment.failed']),
  data: z.object({
    orderId: z.string().min(1).max(100),
    paymentId: z.string().min(1).max(100).optional(),
    amountPaise: z.number().int().positive(),
    failureReason: z.string().max(200).optional(),
  }),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

type WebhookOutcome = 'confirmed' | 'late_capture_refund' | 'amount_mismatch_refund' | 'failed' | 'duplicate' | 'noop';

interface Deps {
  db: DbHandles;
  audit: AuditService;
  gateway: PaymentGateway;
  cache: Cache;
  metrics: Metrics;
  logger: Logger;
  config: AppConfig;
}

export class PaymentsService {
  constructor(private readonly d: Deps) {}

  /**
   * T3 of the booking saga. Providers deliver at-least-once and possibly out of order, so:
   *  1. authenticity: HMAC signature over the raw body + timestamp window (anti-replay);
   *  2. de-duplication: (provider, event_id) primary key, inserted in the same tx;
   *  3. state checks under row locks make every transition idempotent.
   */
  async handleWebhook(rawBody: string, signature: string | undefined, ctx: RequestCtx): Promise<{ outcome: WebhookOutcome }> {
    if (!verifyWebhookSignature(this.d.config.PAYMENT_WEBHOOK_SECRET, rawBody, signature)) {
      this.d.metrics.paymentWebhooks.inc({ type: 'unknown', outcome: 'bad_signature' });
      await this.d.audit.recordSafe(ctx, { action: 'payment.webhook', resourceType: 'payment', outcome: 'denied', metadata: { reason: 'bad_signature' } });
      throw Errors.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
    }
    let event: WebhookEvent;
    try {
      event = WebhookEvent.parse(JSON.parse(rawBody));
    } catch {
      throw Errors.badRequest('INVALID_EVENT', 'Malformed webhook payload');
    }

    const payment = await this.d.db.writer
      .selectFrom('payments as p')
      .innerJoin('consultations as c', 'c.id', 'p.consultation_id')
      .select(['p.id', 'p.consultation_id', 'c.slot_id', 'c.doctor_id'])
      .where('p.provider', '=', this.d.gateway.name)
      .where('p.provider_order_id', '=', event.data.orderId)
      .executeTakeFirst();
    if (!payment) {
      // Possibly a race with T2's commit: a non-2xx makes the provider redeliver later.
      this.d.metrics.paymentWebhooks.inc({ type: event.type, outcome: 'unknown_order' });
      throw Errors.conflict('UNKNOWN_ORDER', 'Order not found (yet)');
    }

    const outcome = await withTransaction(this.d.db.writer, async (tx): Promise<WebhookOutcome> => {
      const fresh = await tx
        .insertInto('payment_webhook_events')
        .values({ provider: this.d.gateway.name, event_id: event.id, event_type: event.type, payload: JSON.stringify(event) })
        .onConflict((oc) => oc.doNothing())
        .returning('event_id')
        .executeTakeFirst();
      if (!fresh) return 'duplicate';

      // Lock order: slot -> consultation -> payment.
      const slot = await tx.selectFrom('availability_slots').selectAll().where('id', '=', payment.slot_id).forUpdate().executeTakeFirstOrThrow();
      const c = await tx.selectFrom('consultations').selectAll().where('id', '=', payment.consultation_id).forUpdate().executeTakeFirstOrThrow();
      const p = await tx.selectFrom('payments').selectAll().where('id', '=', payment.id).forUpdate().executeTakeFirstOrThrow();

      let result: WebhookOutcome;
      if (event.type === 'payment.failed') {
        if (p.status !== 'initiated') return 'noop';
        await tx.updateTable('payments').set({ status: 'failed', failure_reason: event.data.failureReason ?? 'provider_declined' }).where('id', '=', p.id).execute();
        if (c.status === 'pending_payment') {
          await tx
            .updateTable('consultations')
            .set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'payment_failed', version: sql<number>`version + 1` })
            .where('id', '=', c.id)
            .execute();
          await publishEvent(tx, { type: 'consultation', id: c.id }, { type: 'consultation.cancelled', consultationId: c.id, refund: false });
        }
        if (slot.status === 'held' && slot.held_by === c.patient_id) {
          await tx
            .updateTable('availability_slots')
            .set({ status: 'available', held_by: null, hold_expires_at: null, version: sql<number>`version + 1` })
            .where('id', '=', slot.id)
            .execute();
        }
        result = 'failed';
      } else {
        if (p.status !== 'initiated' && p.status !== 'expired') return 'noop';
        await tx
          .updateTable('payments')
          .set({ status: 'captured', provider_payment_id: event.data.paymentId ?? null, captured_at: new Date() })
          .where('id', '=', p.id)
          .execute();

        const amountOk = event.data.amountPaise === p.amount_paise;
        const holdValid = c.status === 'pending_payment' && slot.status === 'held' && slot.held_by === c.patient_id;
        if (amountOk && holdValid) {
          await tx
            .updateTable('availability_slots')
            .set({ status: 'booked', hold_expires_at: null, version: sql<number>`version + 1` })
            .where('id', '=', slot.id)
            .execute();
          await tx.updateTable('consultations').set({ status: 'confirmed', version: sql<number>`version + 1` }).where('id', '=', c.id).execute();
          await publishEvent(tx, { type: 'consultation', id: c.id }, { type: 'booking.confirmed', consultationId: c.id });
          result = 'confirmed';
        } else {
          // Money arrived but we can't honour the booking (hold expired / amount tampered):
          // never keep it — refund automatically.
          await tx.updateTable('payments').set({ status: 'refund_pending', failure_reason: amountOk ? 'late_capture' : 'amount_mismatch' }).where('id', '=', p.id).execute();
          await publishEvent(tx, { type: 'payment', id: p.id }, { type: 'payment.refund_requested', paymentId: p.id });
          result = amountOk ? 'late_capture_refund' : 'amount_mismatch_refund';
        }
      }
      await this.d.audit.record(ctx, { action: 'payment.webhook', resourceType: 'payment', resourceId: p.id, metadata: { eventId: event.id, type: event.type, outcome: result } }, tx);
      return result;
    });

    this.d.metrics.paymentWebhooks.inc({ type: event.type, outcome });
    if (outcome !== 'duplicate' && outcome !== 'noop') await this.d.cache.invalidate(slotsCacheNs(payment.doctor_id));
    return { outcome };
  }

  async getForPatient(patientId: string, paymentId: string) {
    const p = await this.d.db.writer.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
    if (!p || p.patient_id !== patientId) throw Errors.notFound('Payment');
    return {
      id: p.id,
      consultationId: p.consultation_id,
      status: p.status,
      amountPaise: p.amount_paise,
      currency: p.currency,
      provider: p.provider,
      orderId: p.provider_order_id,
      capturedAt: iso(p.captured_at),
      refundedAt: iso(p.refunded_at),
    };
  }

  /** Worker: executes a refund at the provider (idempotent per payment id). */
  async processRefund(paymentId: string): Promise<'refunded' | 'skipped'> {
    const p = await this.d.db.writer.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
    if (!p || p.status !== 'refund_pending' || !p.provider_order_id) return 'skipped';
    const { refundId } = await this.d.gateway.refund({ orderId: p.provider_order_id, amountPaise: p.amount_paise, idempotencyKey: p.id });
    await this.d.db.writer
      .updateTable('payments')
      .set({ status: 'refunded', provider_refund_id: refundId, refunded_at: new Date() })
      .where('id', '=', p.id)
      .where('status', '=', 'refund_pending')
      .execute();
    return 'refunded';
  }

  /**
   * DEV ONLY (mock provider): simulates the hosted checkout calling our webhook, so the
   * whole saga can be demoed locally without a real payment account.
   */
  buildMockWebhook(orderId: string, amountPaise: number, outcome: 'success' | 'failure') {
    const event: WebhookEvent = {
      id: `evt_${crypto.randomUUID()}`,
      type: outcome === 'success' ? 'payment.captured' : 'payment.failed',
      data: {
        orderId,
        amountPaise,
        ...(outcome === 'success' ? { paymentId: `pay_${crypto.randomUUID().slice(0, 18)}` } : { failureReason: 'card_declined' }),
      },
    };
    const body = JSON.stringify(event);
    return { body, signature: signWebhook(this.d.config.PAYMENT_WEBHOOK_SECRET, body) };
  }
}
