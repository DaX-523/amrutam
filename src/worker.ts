import { createServer } from 'node:http';
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { Worker, type Job, type Processor } from 'bullmq';
import { loadConfig } from './config/env.js';
import { createContainer, type Container } from './container.js';
import type { JobPayload } from './jobs/outbox-relay.js';
import { outboxBacklog, relayOutbox } from './jobs/outbox-relay.js';
import { expireHolds } from './jobs/hold-expiry.js';
import {
  cleanup,
  ensureAuditPartitions,
  recentDays,
  rollupAnalytics,
  rotateEncryptionKeys,
} from './jobs/maintenance.js';
import { sendNotification } from './jobs/notifications.js';
import { QUEUES, type QueueName } from './infra/queue.js';
import { bullConnectionOptions } from './infra/redis.js';
import { retry } from './lib/retry.js';

const tracer = trace.getTracer('amrutam-worker');

/** Continues the trace started by the HTTP request that wrote the outbox row. */
function traced<T>(queue: string, job: Job, fn: () => Promise<T>): Promise<T> {
  const carrier = (job.data as Partial<JobPayload>)?.trace ?? {};
  const parent = propagation.extract(context.active(), carrier ?? {});
  return context.with(parent, () =>
    tracer.startActiveSpan(`job ${queue}:${job.name}`, async (span) => {
      span.setAttributes({
        'messaging.system': 'bullmq',
        'messaging.destination.name': queue,
        'job.id': String(job.id),
        'job.attempt': job.attemptsMade + 1,
      });
      try {
        return await fn();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}

function processors(c: Container): Record<Exclude<QueueName, 'dead-letter'>, Processor> {
  return {
    notifications: async (job) => sendNotification(c, (job.data as JobPayload).event),
    'prescription-pdf': async (job) => {
      const { event } = job.data as JobPayload;
      if (event.type !== 'prescription.created') return 'ignored';
      return c.prescriptions.renderPdf(event.prescriptionId);
    },
    payments: async (job) => {
      const { event } = job.data as JobPayload;
      if (event.type !== 'payment.refund_requested') return 'ignored';
      return c.payments.processRefund(event.paymentId);
    },
    maintenance: async (job) => {
      switch (job.name) {
        case 'hold-expiry':
          return { released: await expireHolds(c) };
        case 'analytics-rollup': {
          const range = (job.data as { from?: string; to?: string }) ?? {};
          const r =
            range.from && range.to ? { from: range.from, to: range.to } : recentDays(c.config.APP_TIMEZONE);
          return rollupAnalytics(c, r.from, r.to);
        }
        case 'cleanup':
          return cleanup(c);
        case 'audit-partitions':
          return { partitions: await ensureAuditPartitions(c) };
        case 'key-rotation':
          return rotateEncryptionKeys(c);
        default:
          throw new Error(`unknown maintenance job ${job.name}`);
      }
    },
  };
}

const CONCURRENCY: Record<Exclude<QueueName, 'dead-letter'>, number> = {
  notifications: 10,
  'prescription-pdf': 4,
  payments: 5,
  maintenance: 1,
};

async function main() {
  const config = loadConfig();
  const c = createContainer(config);
  await c.redis.connect();
  await retry(() => c.storage.ensureBucket(), { retries: 6, baseMs: 500, maxMs: 5_000 }).catch(
    (err: unknown) => c.logger.error({ err }, 'object storage unavailable; PDF jobs will retry'),
  );
  const connection = bullConnectionOptions(config.REDIS_URL);
  const procs = processors(c);

  const workers = (Object.keys(procs) as (keyof typeof procs)[]).map((queue) => {
    const worker = new Worker(
      queue,
      async (job) => {
        const end = c.metrics.jobDuration.startTimer({ queue });
        try {
          return await traced(queue, job, () => procs[queue](job));
        } finally {
          end();
        }
      },
      { connection, prefix: 'amrutam', concurrency: CONCURRENCY[queue] },
    );
    worker.on('completed', () => c.metrics.jobs.inc({ queue, status: 'completed' }));
    worker.on('failed', async (job, err) => {
      c.metrics.jobs.inc({ queue, status: 'failed' });
      c.logger.warn({ err, queue, jobId: job?.id, attempt: job?.attemptsMade }, 'job attempt failed');
      // Exhausted all retries -> dead-letter queue for inspection / manual replay.
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        c.metrics.jobs.inc({ queue, status: 'dead_lettered' });
        await c.queues['dead-letter'].add(`${queue}:${job.name}`, {
          queue,
          name: job.name,
          data: job.data,
          error: err.message,
          failedAt: new Date().toISOString(),
        });
        if (queue === QUEUES.prescriptionPdf) {
          const ev = (job.data as JobPayload).event;
          if (ev.type === 'prescription.created') await c.prescriptions.markPdfFailed(ev.prescriptionId);
        }
      }
    });
    worker.on('error', (err) => c.logger.error({ err, queue }, 'worker error'));
    return worker;
  });

  // Recurring jobs (idempotent upserts: safe with many worker replicas).
  const m = c.queues.maintenance;
  await m.upsertJobScheduler('hold-expiry', { every: 30_000 }, { name: 'hold-expiry' });
  await m.upsertJobScheduler('analytics-rollup', { every: 5 * 60_000 }, { name: 'analytics-rollup' });
  await m.upsertJobScheduler('cleanup', { pattern: '17 * * * *' }, { name: 'cleanup' });
  await m.upsertJobScheduler('audit-partitions', { pattern: '5 0 * * *' }, { name: 'audit-partitions' });
  await m.upsertJobScheduler('key-rotation', { pattern: '30 2 * * *' }, { name: 'key-rotation' });

  // Outbox relay: tight polling loop (low latency), SKIP LOCKED makes replicas cooperate.
  let running = true;
  const relayLoop = (async () => {
    while (running) {
      try {
        const n = await relayOutbox(c);
        if (n === 0) await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        c.logger.error({ err }, 'outbox relay failed');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  })();

  // Queue depth + outbox lag gauges for dashboards/alerts.
  const gauges = setInterval(async () => {
    try {
      for (const [name, q] of Object.entries(c.queues)) {
        const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts)) c.metrics.queueDepth.set({ queue: name, state }, n);
      }
      c.metrics.outboxLag.set(await outboxBacklog(c));
    } catch (err) {
      c.logger.warn({ err }, 'failed to collect queue gauges');
    }
  }, 15_000);

  const metricsServer = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', c.metrics.registry.contentType);
      res.end(await c.metrics.registry.metrics());
    } else if (req.url === '/health/live') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  }).listen(config.WORKER_METRICS_PORT);

  c.logger.info({ queues: Object.keys(procs) }, 'worker started');

  const shutdown = async (signal: string) => {
    c.logger.info({ signal }, 'worker shutting down');
    running = false;
    clearInterval(gauges);
    metricsServer.close();
    await Promise.all(workers.map((w) => w.close())); // waits for active jobs
    await relayLoop;
    await c.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`worker fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
