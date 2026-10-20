/**
 * Generates docs/openapi.yaml from the route schemas (single source of truth: the Zod
 * schemas that also validate requests). CI fails if the committed file is stale.
 * Needs no database/Redis: nothing connects until a request is served.
 */
import { writeFileSync } from 'node:fs';
import { pino } from 'pino';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createContainer } from '../src/container.js';
import type { Queues } from '../src/infra/queue.js';

const dummy = 'x'.repeat(40);
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_SIGNING_KEYS: `k:${dummy}`,
  JWT_ACTIVE_KID: 'k',
  ENCRYPTION_KEYS: `e:${Buffer.alloc(32).toString('base64')}`,
  ENCRYPTION_ACTIVE_KEY_ID: 'e',
  BLIND_INDEX_KEY: dummy,
  PAYMENT_WEBHOOK_SECRET: dummy,
  MOCK_CHECKOUT_ENABLED: 'true',
});
const container = createContainer(config, { logger: pino({ level: 'silent' }), queues: {} as Queues });
const app = await buildApp(container);
await app.ready();
const yaml = app.swagger({ yaml: true });
writeFileSync(new URL('../docs/openapi.yaml', import.meta.url), yaml);
console.log(`docs/openapi.yaml written (${yaml.split('\n').length} lines)`);
await app.close();
await container.db.close();
container.redis.disconnect();
