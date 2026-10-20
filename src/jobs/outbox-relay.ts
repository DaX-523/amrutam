import { sql } from 'kysely';
import type { Container } from '../container.js';
import type { DomainEvent } from '../infra/outbox.js';
import { QUEUES, type QueueName } from '../infra/queue.js';

/** Event type -> (queue, job name) fan-out. */
const ROUTES: Record<DomainEvent['type'], { queue: QueueName; job: string }[]> = {
  'booking.held': [],
  'booking.confirmed': [{ queue: QUEUES.notifications, job: 'booking-confirmed' }],
  'consultation.cancelled': [{ queue: QUEUES.notifications, job: 'consultation-cancelled' }],
  'consultation.completed': [{ queue: QUEUES.notifications, job: 'consultation-completed' }],
  'payment.refund_requested': [{ queue: QUEUES.payments, job: 'refund' }],
  'prescription.created': [{ queue: QUEUES.prescriptionPdf, job: 'render' }],
  'prescription.pdf_ready': [{ queue: QUEUES.notifications, job: 'prescription-ready' }],
};

export interface JobPayload {
  event: DomainEvent;
  outboxId: string;
  trace: Record<string, string> | null;
}

/**
 * Moves committed outbox rows into BullMQ. Safe with N relays in parallel
 * (FOR UPDATE SKIP LOCKED). At-least-once: if the commit fails after enqueueing,
 * the deterministic jobId makes the re-enqueue a no-op.
 */
export async function relayOutbox(c: Container, batchSize = 100): Promise<number> {
  return c.db.writer.transaction().execute(async (tx) => {
    const rows = await tx
      .selectFrom('outbox_events')
      .select(['id', 'event_type', 'payload', 'trace_context'])
      .where('published_at', 'is', null)
      .orderBy('id')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return 0;

    for (const row of rows) {
      const event = row.payload as unknown as DomainEvent;
      const routes = ROUTES[event.type] ?? [];
      for (const r of routes) {
        const data: JobPayload = { event, outboxId: row.id, trace: row.trace_context };
        await c.queues[r.queue].add(r.job, data, { jobId: `outbox-${row.id}-${r.job}` });
      }
    }
    await tx
      .updateTable('outbox_events')
      .set({ published_at: sql<Date>`now()`, attempts: sql<number>`attempts + 1` })
      .where('id', 'in', rows.map((r) => r.id))
      .execute();
    return rows.length;
  });
}

export async function outboxBacklog(c: Container): Promise<number> {
  const r = await c.db.writer
    .selectFrom('outbox_events')
    .select(sql<string>`count(*)`.as('n'))
    .where('published_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
