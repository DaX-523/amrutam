import { sql } from 'kysely';
import type { Container } from '../container.js';

/** Purges expired idempotency records and old relayed outbox rows. */
export async function cleanup(c: Container) {
  const idem = await c.db.writer.deleteFrom('idempotency_keys').where('expires_at', '<', sql<Date>`now()`).executeTakeFirst();
  const outbox = await c.db.writer
    .deleteFrom('outbox_events')
    .where('published_at', '<', sql<Date>`now() - interval '7 days'`)
    .executeTakeFirst();
  return { idempotencyKeys: Number(idem.numDeletedRows), outboxEvents: Number(outbox.numDeletedRows) };
}

/** Pre-creates audit partitions for the next months (partition maintenance). */
export async function ensureAuditPartitions(c: Container, monthsAhead = 3) {
  const created: string[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const r = await sql<{ p: string }>`SELECT ensure_audit_partition(now() + make_interval(months => ${i})) AS p`.execute(c.db.writer);
    created.push(r.rows[0]!.p);
  }
  return created;
}

export async function rollupAnalytics(c: Container, from: string, to: string) {
  const days: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length > 400) throw new Error('rollup range too large');
  for (const day of days) await c.analytics.rollupDay(day);
  return { days: days.length };
}

/** Today and yesterday in the clinic timezone (late-arriving events affect yesterday). */
export function recentDays(tz: string): { from: string; to: string } {
  const fmt = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  return { from: fmt(new Date(Date.now() - 86_400_000)), to: fmt(new Date()) };
}

/**
 * Key rotation: re-encrypts every PHI column still under a retired key id with the active
 * key, in small batches. After it reports zero remaining rows the old key can be removed
 * from ENCRYPTION_KEYS (idempotency responses are not rotated: they expire within
 * IDEMPOTENCY_TTL_HOURS, so keep the old key at least that long). Safe to run repeatedly
 * and concurrently with traffic.
 */
const ENCRYPTED_COLUMNS = [
  { table: 'profiles', pk: 'user_id', column: 'phone_enc', aad: 'profiles.phone' },
  { table: 'profiles', pk: 'user_id', column: 'dob_enc', aad: 'profiles.dob' },
  { table: 'users', pk: 'id', column: 'mfa_secret_enc', aad: 'users.mfa_secret' },
  { table: 'consultations', pk: 'id', column: 'reason_enc', aad: 'consultations.reason' },
  { table: 'consultations', pk: 'id', column: 'notes_enc', aad: 'consultations.notes' },
  { table: 'prescriptions', pk: 'id', column: 'items_enc', aad: 'prescriptions.items' },
  { table: 'prescriptions', pk: 'id', column: 'advice_enc', aad: 'prescriptions.advice' },
] as const;

export async function rotateEncryptionKeys(c: Container, batchSize = 500) {
  const active = c.cipher.activeKey;
  const report: Record<string, number> = {};
  for (const col of ENCRYPTED_COLUMNS) {
    let total = 0;
    for (;;) {
      const { rows } = await sql<{ pk: string; value: string }>`
        SELECT ${sql.ref(col.pk)}::text AS pk, ${sql.ref(col.column)} AS value FROM ${sql.table(col.table)}
        WHERE ${sql.ref(col.column)} IS NOT NULL AND ${sql.ref(col.column)} NOT LIKE ${`enc:${active}:%`}
        LIMIT ${batchSize}
      `.execute(c.db.writer);
      if (rows.length === 0) break;
      for (const row of rows) {
        const rotated = c.cipher.rotate(row.value, col.aad);
        if (!rotated) continue;
        // Compare-and-swap on the old ciphertext so a concurrent user update is never lost.
        await sql`UPDATE ${sql.table(col.table)} SET ${sql.ref(col.column)} = ${rotated}
                  WHERE ${sql.ref(col.pk)}::text = ${row.pk} AND ${sql.ref(col.column)} = ${row.value}`.execute(c.db.writer);
      }
      total += rows.length;
      if (rows.length < batchSize) break;
    }
    report[`${col.table}.${col.column}`] = total;
  }
  return { activeKey: active, reencrypted: report };
}
