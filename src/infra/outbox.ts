import { context, propagation } from '@opentelemetry/api';
import type { Tx } from './db.js';

/**
 * Transactional outbox. Domain events are inserted in the SAME transaction as the state
 * change, so "DB committed but job never enqueued" (or vice versa) cannot happen.
 * The relay (jobs/outbox-relay.ts) publishes them to BullMQ at-least-once; consumers are
 * idempotent (BullMQ jobId = outbox id, plus state checks in handlers).
 */
export type DomainEvent =
  | { type: 'booking.held'; consultationId: string }
  | { type: 'booking.confirmed'; consultationId: string }
  | { type: 'consultation.cancelled'; consultationId: string; refund: boolean }
  | { type: 'consultation.completed'; consultationId: string }
  | { type: 'payment.refund_requested'; paymentId: string }
  | { type: 'prescription.created'; prescriptionId: string }
  | { type: 'prescription.pdf_ready'; prescriptionId: string };

export async function publishEvent(
  tx: Tx,
  aggregate: { type: string; id: string },
  event: DomainEvent,
): Promise<void> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  await tx
    .insertInto('outbox_events')
    .values({
      aggregate_type: aggregate.type,
      aggregate_id: aggregate.id,
      event_type: event.type,
      payload: JSON.stringify(event),
      trace_context: Object.keys(carrier).length ? JSON.stringify(carrier) : null,
    })
    .execute();
}
