import { sql, type Expression, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { RequestCtx } from '../../domain/context.js';
import { Errors } from '../../domain/errors.js';
import type { Cache } from '../../infra/cache.js';
import { canonicalJson, sha256Hex } from '../../infra/crypto.js';
import { withTransaction, type DbHandles } from '../../infra/db.js';
import type { AuditService } from '../audit/audit.service.js';
import { decodeCursor, encodeCursor, iso } from '../common/schemas.js';
import type { DoctorDto, SearchDoctorsInput, UpsertDoctorProfileInput } from './doctors.schemas.js';

export const DOCTORS_CACHE_NS = 'doctors';
const SEARCH_TTL_SEC = 30;
const CursorSchema = z.object({ v: z.union([z.string(), z.number()]), id: z.uuid() });

interface Deps {
  db: DbHandles;
  cache: Cache;
  audit: AuditService;
  config: AppConfig;
}

interface DoctorRow {
  user_id: string;
  display_name: string;
  specialties: string[];
  languages: string[];
  qualifications: string[];
  years_experience: number;
  fee_paise: number;
  city: string | null;
  bio: string | null;
  rating: string;
  rating_count: number;
  verified_at: Date | null;
  next_available_at: Date | null;
  sort_value?: string | number;
}

export function toDoctorDto(r: DoctorRow): DoctorDto {
  return {
    id: r.user_id,
    displayName: r.display_name,
    specialties: r.specialties,
    languages: r.languages,
    qualifications: r.qualifications,
    yearsExperience: r.years_experience,
    feePaise: r.fee_paise,
    city: r.city,
    bio: r.bio,
    rating: Number(r.rating),
    ratingCount: r.rating_count,
    verified: r.verified_at !== null,
    nextAvailableAt: iso(r.next_available_at),
  };
}

export class DoctorsService {
  constructor(private readonly d: Deps) {}

  private baseQuery(db = this.d.db.reader) {
    return db
      .selectFrom('doctors as d')
      .innerJoin('users as u', 'u.id', 'd.user_id')
      .select([
        'd.user_id', 'd.display_name', 'd.specialties', 'd.languages', 'd.qualifications', 'd.years_experience',
        'd.fee_paise', 'd.city', 'd.bio', 'd.rating', 'd.rating_count', 'd.verified_at',
        sql<Date | null>`(
          SELECT min(s.starts_at) FROM availability_slots s
          WHERE s.doctor_id = d.user_id AND s.status = 'available' AND s.starts_at > now()
        )`.as('next_available_at'),
      ])
      .where('u.status', '=', 'active');
  }

  async upsertOwnProfile(userId: string, input: UpsertDoctorProfileInput, ctx: RequestCtx): Promise<DoctorDto> {
    await withTransaction(this.d.db.writer, async (tx) => {
      const existing = await tx
        .selectFrom('doctors')
        .select(['registration_number'])
        .where('user_id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      const values = {
        display_name: input.displayName,
        registration_number: input.registrationNumber,
        specialties: input.specialties,
        languages: input.languages,
        qualifications: input.qualifications,
        years_experience: input.yearsExperience,
        fee_paise: input.feePaise,
        city: input.city ?? null,
        bio: input.bio ?? null,
      };
      if (existing) {
        // A changed medical registration number must be re-verified by an admin.
        const reverify = existing.registration_number !== input.registrationNumber;
        await tx
          .updateTable('doctors')
          .set({ ...values, ...(reverify ? { verified_at: null, verified_by: null } : {}) })
          .where('user_id', '=', userId)
          .execute();
      } else {
        await tx.insertInto('doctors').values({ user_id: userId, ...values, verified_at: null, verified_by: null }).execute();
      }
      await this.d.audit.record(ctx, { action: existing ? 'doctor.profile_updated' : 'doctor.profile_created', resourceType: 'doctor', resourceId: userId }, tx);
    });
    await this.d.cache.invalidate(DOCTORS_CACHE_NS);
    return this.getById(userId, { includeUnverified: true, fresh: true });
  }

  /** `fresh` reads from the primary (read-your-writes after an update). */
  async getById(id: string, opts: { includeUnverified?: boolean; fresh?: boolean } = {}): Promise<DoctorDto> {
    let q = this.baseQuery(opts.fresh ? this.d.db.writer : this.d.db.reader).where('d.user_id', '=', id);
    if (!opts.includeUnverified) q = q.where('d.verified_at', 'is not', null);
    const row = await q.executeTakeFirst();
    if (!row) throw Errors.notFound('Doctor');
    return toDoctorDto(row);
  }

  /**
   * Discovery search on the read replica, cached for 30s per distinct query.
   * Full-text (tsvector, weighted) + trigram fuzzy name matching, array containment
   * filters (GIN), and keyset pagination (stable, O(log n) per page, no OFFSET scans).
   */
  async search(params: SearchDoctorsInput): Promise<{ items: DoctorDto[]; nextCursor: string | null }> {
    if (params.minFee !== undefined && params.maxFee !== undefined && params.minFee > params.maxFee) {
      throw Errors.badRequest('INVALID_RANGE', 'minFee must be <= maxFee');
    }
    const version = await this.d.cache.namespaceVersion(DOCTORS_CACHE_NS);
    const key = `search:v${version}:${sha256Hex(canonicalJson(params)).slice(0, 32)}`;
    return this.d.cache.getOrSet('doctor_search', key, SEARCH_TTL_SEC, () => this.searchUncached(params));
  }

  private async searchUncached(p: SearchDoctorsInput) {
    const sort = p.sort === 'relevance' && !p.q ? 'rating' : p.sort;
    const tsq = p.q ? sql`websearch_to_tsquery('simple', ${p.q})` : null;
    const rankExpr = p.q
      ? sql<string>`round((ts_rank_cd(d.search_tsv, ${tsq}) + similarity(d.display_name, ${p.q}))::numeric, 6)`
      : sql<string>`0`;

    let q = this.baseQuery().where('d.verified_at', 'is not', null);
    if (p.q) {
      q = q.where(sql<SqlBool>`(d.search_tsv @@ ${tsq} OR d.display_name % ${p.q})`);
    }
    if (p.specialty) q = q.where(sql<SqlBool>`d.specialties @> ARRAY[${p.specialty}]::text[]`);
    if (p.language) q = q.where(sql<SqlBool>`d.languages @> ARRAY[${p.language}]::text[]`);
    if (p.city) q = q.where(sql<SqlBool>`lower(d.city) = lower(${p.city})`);
    if (p.minFee !== undefined) q = q.where('d.fee_paise', '>=', p.minFee);
    if (p.maxFee !== undefined) q = q.where('d.fee_paise', '<=', p.maxFee);
    if (p.minRating !== undefined) q = q.where('d.rating', '>=', String(p.minRating));
    if (p.availableOn) {
      const tz = this.d.config.APP_TIMEZONE;
      q = q.where(sql<SqlBool>`EXISTS (
        SELECT 1 FROM availability_slots s
        WHERE s.doctor_id = d.user_id AND s.status = 'available' AND s.starts_at > now()
          AND s.starts_at >= (${p.availableOn}::date)::timestamp AT TIME ZONE ${tz}
          AND s.starts_at <  (${p.availableOn}::date + 1)::timestamp AT TIME ZONE ${tz}
      )`);
    }

    // Keyset pagination: (sort_value, id) strictly after the cursor in sort order.
    const specs: Record<typeof sort, { expr: RawBuilder<string | number>; dir: 'asc' | 'desc' }> = {
      relevance: { expr: rankExpr, dir: 'desc' },
      rating: { expr: sql<string>`d.rating`, dir: 'desc' },
      fee: { expr: sql<number>`d.fee_paise`, dir: 'asc' },
      experience: { expr: sql<number>`d.years_experience`, dir: 'desc' },
    };
    const spec = specs[sort];
    const cursor = decodeCursor(p.cursor, CursorSchema);
    if (p.cursor && !cursor) throw Errors.badRequest('INVALID_CURSOR', 'Malformed pagination cursor');
    if (cursor) {
      const cmp = spec.dir === 'desc' ? sql.raw('<') : sql.raw('>');
      q = q.where(
        sql<SqlBool>`(${spec.expr} ${cmp} ${cursor.v} OR (${spec.expr} = ${cursor.v} AND d.user_id > ${cursor.id}))` as Expression<SqlBool>,
      );
    }
    const rows = await q
      .select(spec.expr.as('sort_value'))
      .orderBy(spec.expr, spec.dir)
      .orderBy('d.user_id', 'asc')
      .limit(p.limit + 1)
      .execute();

    const hasMore = rows.length > p.limit;
    const page = rows.slice(0, p.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDoctorDto),
      nextCursor: hasMore && last ? encodeCursor({ v: last.sort_value, id: last.user_id }) : null,
    };
  }
}
