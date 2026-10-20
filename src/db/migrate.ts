import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { migrations } from './migrations/index.js';

/**
 * Runs pending migrations. Kysely's migrator takes a Postgres advisory lock, so it's safe
 * to run from several pods at once (in K8s it runs as a pre-deploy Job).
 * Usage: npm run migrate [-- down]
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });

  const direction = process.argv[2] === 'down' ? 'down' : 'latest';
  const { error, results } = direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();
  for (const r of results ?? []) {
    process.stdout.write(`${r.status === 'Success' ? '✔' : '✘'} ${r.direction} ${r.migrationName}\n`);
  }
  await db.destroy();
  if (error) {
    process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  if (!results?.length) process.stdout.write('no pending migrations\n');
}

void main();
