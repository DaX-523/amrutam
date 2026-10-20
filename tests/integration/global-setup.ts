import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrations } from '../../src/db/migrations/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/**
 * Spins up throwaway Postgres 16 + Redis 7 containers (Testcontainers), or reuses
 * TEST_DATABASE_URL / TEST_REDIS_URL when provided (e.g. CI service containers).
 */
export default async function setup(project: TestProject) {
  let pgc: StartedPostgreSqlContainer | undefined;
  let rc: StartedRedisContainer | undefined;
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;
  if (!databaseUrl) {
    pgc = await new PostgreSqlContainer('postgres:16-alpine').start();
    databaseUrl = pgc.getConnectionUri();
  }
  if (!redisUrl) {
    rc = await new RedisContainer('redis:7-alpine').start();
    redisUrl = rc.getConnectionUrl();
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 1 }) }),
  });
  const { error } = await new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  }).migrateToLatest();
  await db.destroy();
  if (error) throw error;

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);

  return async () => {
    await pgc?.stop();
    await rc?.stop();
  };
}
