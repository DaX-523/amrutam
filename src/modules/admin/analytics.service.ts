import { sql } from 'kysely';
import type { AppConfig } from '../../config/env.js';
import type { DbHandles } from '../../infra/db.js';

/**
 * Admin analytics are served from `analytics_daily` (pre-aggregated by a background job)
 * so dashboards cost O(days) instead of scanning millions of consultations per request.
 */
export class AnalyticsService {
  constructor(private readonly d: { db: DbHandles; config: AppConfig }) {}

  /** Recomputes all metrics for one calendar day (clinic timezone). Idempotent upsert. */
  async rollupDay(day: string): Promise<number> {
    const tz = this.d.config.APP_TIMEZONE;
    const start = sql`(${day}::date)::timestamp AT TIME ZONE ${tz}`;
    const end = sql`(${day}::date + 1)::timestamp AT TIME ZONE ${tz}`;
    const result = await sql`
      WITH c AS (
        SELECT c.*, d.specialties FROM consultations c JOIN doctors d ON d.user_id = c.doctor_id
        WHERE c.scheduled_at >= ${start} AND c.scheduled_at < ${end}
      ),
      metrics(metric, dimension, value) AS (
        SELECT 'consultations', status::text, count(*)::numeric FROM c GROUP BY status
        UNION ALL
        SELECT 'consultations_total', '', count(*)::numeric FROM c
        UNION ALL
        SELECT 'unique_patients', '', count(DISTINCT patient_id)::numeric FROM c
        UNION ALL
        SELECT 'consultations_by_specialty', s, count(*)::numeric
          FROM c, unnest(c.specialties) s WHERE c.status NOT IN ('cancelled') GROUP BY s
        UNION ALL
        SELECT 'bookings_created', '', count(*)::numeric FROM consultations
          WHERE created_at >= ${start} AND created_at < ${end}
        UNION ALL
        SELECT 'revenue_paise', '', coalesce(sum(amount_paise), 0)::numeric FROM payments
          WHERE captured_at >= ${start} AND captured_at < ${end}  -- gross: includes later-refunded
        UNION ALL
        SELECT 'refunds_paise', '', coalesce(sum(amount_paise), 0)::numeric FROM payments
          WHERE status = 'refunded' AND refunded_at >= ${start} AND refunded_at < ${end}
        UNION ALL
        SELECT 'slots_published', '', count(*)::numeric FROM availability_slots
          WHERE starts_at >= ${start} AND starts_at < ${end}
        UNION ALL
        SELECT 'slots_booked', '', count(*)::numeric FROM availability_slots
          WHERE status = 'booked' AND starts_at >= ${start} AND starts_at < ${end}
        UNION ALL
        SELECT 'new_users', role::text, count(*)::numeric FROM users
          WHERE created_at >= ${start} AND created_at < ${end} GROUP BY role
      )
      INSERT INTO analytics_daily (day, metric, dimension, value, computed_at)
      SELECT ${day}::date, metric, dimension, value, now() FROM metrics
      ON CONFLICT (day, metric, dimension) DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at
    `.execute(this.d.db.writer);
    return Number(result.numAffectedRows ?? 0);
  }

  async overview(from: string, to: string) {
    const rows = await this.d.db.reader
      .selectFrom('analytics_daily')
      .select(['day', 'metric', 'dimension', 'value', 'computed_at'])
      .where('day', '>=', from)
      .where('day', '<=', to)
      .orderBy('day')
      .execute();

    const sum = (metric: string, dimension?: string) =>
      rows
        .filter((r) => r.metric === metric && (dimension === undefined || r.dimension === dimension))
        .reduce((a, r) => a + Number(r.value), 0);
    const byDimension = (metric: string) => {
      const acc: Record<string, number> = {};
      for (const r of rows.filter((x) => x.metric === metric))
        acc[r.dimension] = (acc[r.dimension] ?? 0) + Number(r.value);
      return acc;
    };
    const total = sum('consultations_total');
    const published = sum('slots_published');
    const days = [...new Set(rows.map((r) => r.day))];

    return {
      range: { from, to },
      totals: {
        consultations: total,
        byStatus: byDimension('consultations'),
        bookingsCreated: sum('bookings_created'),
        uniquePatientsDaySum: sum('unique_patients'),
        revenuePaise: sum('revenue_paise'),
        refundsPaise: sum('refunds_paise'),
        netRevenuePaise: sum('revenue_paise') - sum('refunds_paise'),
        cancellationRate: total ? round(sum('consultations', 'cancelled') / total) : 0,
        noShowRate: total ? round(sum('consultations', 'no_show') / total) : 0,
        slotUtilization: published ? round(sum('slots_booked') / published) : 0,
        newUsers: byDimension('new_users'),
      },
      topSpecialties: Object.entries(byDimension('consultations_by_specialty'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([specialty, consultations]) => ({ specialty, consultations })),
      daily: days.map((day) => ({
        day,
        consultations: sum2(rows, day, 'consultations_total'),
        revenuePaise: sum2(rows, day, 'revenue_paise'),
        bookingsCreated: sum2(rows, day, 'bookings_created'),
      })),
      computedAt: rows.length
        ? new Date(Math.max(...rows.map((r) => new Date(r.computed_at).getTime()))).toISOString()
        : null,
    };
  }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const sum2 = (rows: { day: string; metric: string; value: string }[], day: string, metric: string) =>
  rows.filter((r) => r.day === day && r.metric === metric).reduce((a, r) => a + Number(r.value), 0);
