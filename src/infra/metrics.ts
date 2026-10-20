import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. HTTP follows the RED method; business counters make the booking
 * funnel and payment health visible on the Grafana dashboard and in alert rules.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly bookings = new Counter({
    name: 'bookings_total',
    help: 'Booking attempts by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly consultationTransitions = new Counter({
    name: 'consultation_transitions_total',
    help: 'Consultation state transitions',
    labelNames: ['from', 'to'] as const,
    registers: [this.registry],
  });

  readonly paymentWebhooks = new Counter({
    name: 'payment_webhooks_total',
    help: 'Payment webhook deliveries',
    labelNames: ['type', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly authEvents = new Counter({
    name: 'auth_events_total',
    help: 'Authentication events',
    labelNames: ['event', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly idempotency = new Counter({
    name: 'idempotency_requests_total',
    help: 'Idempotency layer decisions',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly cache = new Counter({
    name: 'cache_requests_total',
    help: 'Cache lookups',
    labelNames: ['cache', 'result'] as const,
    registers: [this.registry],
  });

  readonly circuitState = new Gauge({
    name: 'circuit_breaker_open',
    help: '1 when the named circuit breaker is open',
    labelNames: ['name'] as const,
    registers: [this.registry],
  });

  readonly jobs = new Counter({
    name: 'jobs_processed_total',
    help: 'Background jobs processed',
    labelNames: ['queue', 'status'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new Histogram({
    name: 'job_duration_seconds',
    help: 'Background job duration',
    labelNames: ['queue'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
    registers: [this.registry],
  });

  readonly queueDepth = new Gauge({
    name: 'queue_jobs',
    help: 'Jobs per queue and state',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_unpublished_events',
    help: 'Outbox events not yet relayed',
    registers: [this.registry],
  });

  constructor(service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry });
  }
}
