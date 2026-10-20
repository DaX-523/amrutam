import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createContainer } from './container.js';

async function main() {
  const config = loadConfig();
  const container = createContainer(config);
  await container.redis.connect().catch((err: unknown) => {
    // Redis is soft-required by the API (cache/rate limits fail open); keep booting.
    container.logger.warn({ err }, 'redis unavailable at startup');
  });
  const app = await buildApp(container);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down gracefully');
    const force = setTimeout(() => process.exit(1), 20_000).unref();
    try {
      await app.close(); // stops accepting, drains in-flight requests
      await container.close();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
