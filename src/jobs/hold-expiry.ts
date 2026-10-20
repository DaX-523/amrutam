import { sql } from 'kysely';
import type { Container } from '../container.js';
import { systemCtx } from '../domain/context.js';
import { slotsCacheNs } from '../modules/availability/availability.service.js';

/**
 * Saga timeout compensation: releases slots whose payment hold expired, cancels the
 * pending consultation and expires the payment — in ONE statement (data-modifying CTEs),
 * honouring the global lock order slot -> consultation -> payment. SKIP LOCKED lets several
 * workers run this concurrently and avoids blocking a webhook that is confirming a slot.
 */
export async function expireHolds(c: Container, batchSize = 500): Promise<number> {
  const { rows } = await sql<{ slot_id: string; doctor_id: string; consultation_id: string | null }>`
    WITH expired AS (
      SELECT id FROM availability_slots
      WHERE status = 'held' AND hold_expires_at < now()
      ORDER BY hold_expires_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    ), released AS (
      UPDATE availability_slots s
      SET status = 'available', held_by = NULL, hold_expires_at = NULL, version = s.version + 1
      FROM expired e WHERE s.id = e.id
      RETURNING s.id, s.doctor_id
    ), cancelled AS (
      UPDATE consultations c
      SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'payment_timeout', version = c.version + 1
      FROM released r WHERE c.slot_id = r.id AND c.status = 'pending_payment'
      RETURNING c.id, c.slot_id
    ), expired_payments AS (
      UPDATE payments p SET status = 'expired', failure_reason = 'hold_expired'
      FROM cancelled x WHERE p.consultation_id = x.id AND p.status = 'initiated'
      RETURNING p.id
    ), events AS (
      INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
      SELECT 'consultation', x.id::text, 'consultation.cancelled',
             jsonb_build_object('type', 'consultation.cancelled', 'consultationId', x.id, 'refund', false)
      FROM cancelled x
      RETURNING id
    )
    SELECT r.id AS slot_id, r.doctor_id, x.id AS consultation_id
    FROM released r LEFT JOIN cancelled x ON x.slot_id = r.id
  `.execute(c.db.writer);

  if (rows.length > 0) {
    await c.audit.recordSafe(systemCtx('job:hold-expiry'), {
      action: 'system.holds_expired',
      resourceType: 'availability_slot',
      metadata: { slots: rows.length, consultations: rows.filter((r) => r.consultation_id).length },
    });
    for (const doctorId of new Set(rows.map((r) => r.doctor_id)))
      await c.cache.invalidate(slotsCacheNs(doctorId));
    c.metrics.bookings.inc({ outcome: 'hold_expired' }, rows.length);
  }
  return rows.length;
}
