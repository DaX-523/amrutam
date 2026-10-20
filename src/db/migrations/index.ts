import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_core_schema.js';
import * as m0002 from './0002_compliance_and_infra.js';

/** Static registry: bundler-safe, ordered, and reviewable. Append-only. */
export const migrations: Record<string, Migration> = {
  '0001_core_schema': m0001,
  '0002_compliance_and_infra': m0002,
};
