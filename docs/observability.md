# Observability

There are three correlated signals, all built on open-source components and running locally with `docker compose up`.

| Signal | Producer | Pipeline | UI |
|---|---|---|---|
| **Metrics** | `prom-client` in the API (`/metrics`) and the worker (`:9464/metrics`), plus postgres and redis exporters | Prometheus scrape (15 s), recording and alert rules | Grafana: **Amrutam — Service Overview** |
| **Traces** | OpenTelemetry Node SDK, auto-instrumenting http, pg, ioredis and the AWS SDK, plus manual job spans | OTLP → OTel Collector (memory limiter, scrubbing, batching) → Jaeger | Jaeger (`:16686`) |
| **Logs** | pino JSON to stdout, carrying `trace_id`/`span_id` and `reqId`, with PHI and secrets redacted | Grafana Alloy (Docker discovery) → Loki (level label, trace_id metadata) | Grafana Explore / dashboard logs panel → click `trace_id` to open Jaeger |

**End-to-end tracing.** A booking request's trace continues into the worker. The W3C `traceparent` is stored in the outbox row with the domain event and restored when the job runs, so a single trace shows `POST /v1/bookings → pg → outbox → job notifications:booking-confirmed → SMTP`. HTTP spans are named by route template (`POST /v1/bookings`) to keep cardinality bounded.

## SLOs and alerts (`infra/compose/prometheus/rules/slo.yml`)

| SLO | SLI (recording rule) | Alert |
|---|---|---|
| Availability 99.95 % (≈22 min/month) | `sli:http_error_ratio:rate5m` / `rate1h` | `ErrorBudgetFastBurn`: 14.4× burn on both the 1 h and 5 m windows (pages) |
| Reads p95 < 200 ms | `sli:http_read_latency:p95_5m` | `ReadLatencySLOBreach` (10 m) |
| Writes p95 < 500 ms | `sli:http_write_latency:p95_5m` | `WriteLatencySLOBreach` (10 m) |

Platform and security alerts:
- `TargetDown`
- `PaymentGatewayCircuitOpen`
- `DeadLetterQueueNotEmpty`
- `OutboxBacklog`
- `PostgresConnectionsHigh`
- `LoginFailureSpike` (credential stuffing)
- `RefreshTokenReuse` (token theft)
- `WebhookSignatureFailures` (forgery attempts)

## Key metrics

| Metric | Labels | Purpose |
|---|---|---|
| `http_request_duration_seconds` (histogram) | method, route, status_code | RED, SLOs |
| `bookings_total` | outcome = held / slot_unavailable / gateway_failed / hold_expired | Booking funnel, contention |
| `consultation_transitions_total` | from, to | Lifecycle health (no-shows, cancellations) |
| `payment_webhooks_total` | type, outcome (confirmed, duplicate, late_capture_refund, bad_signature…) | Payment health and fraud signals |
| `auth_events_total` | event, outcome | Login and MFA success, lockouts, refresh-token reuse |
| `idempotency_requests_total` | result = new / replayed / mismatch / in_progress / takeover | Client retry behaviour |
| `cache_requests_total` | cache, result | Hit ratio (search, slots) |
| `circuit_breaker_open` | name | Dependency health |
| `jobs_processed_total`, `job_duration_seconds` | queue, status | Async throughput, failures, DLQ |
| `queue_jobs` | queue, state | Backlog |
| `outbox_unpublished_events` | — | Relay lag |
| Node default metrics | — | Event-loop lag, heap, GC |

## Dashboard

The Grafana dashboard (provisioned from `infra/compose/grafana/dashboards/amrutam-overview.json`) has these rows:
1. **SLO stats:** p95 read and write latency, error ratio against budget, request rate.
2. **HTTP RED:** request rate and p95 by route, status codes.
3. **Business:** booking outcomes, consultation transitions, webhooks, auth events, idempotency decisions, circuit breaker.
4. **Async & dependencies:** queue depth, job rates, outbox and DLQ, cache hit ratio, Postgres connections, event-loop lag.
5. **Logs:** warn and error logs for the API and worker, with trace links.

## Debugging a slow booking

1. Grafana shows the p95 write stat turning red. The "p95 latency by route" panel points at `POST /v1/bookings`.
2. In Jaeger, filter `service=amrutam-api operation="POST /v1/bookings" minDuration=300ms`. The span waterfall shows which part is slow: a pg query, the payment provider span, or waiting on a lock.
3. Copy the trace id and run `{service="api"} |= "<trace_id>"` in Loki to get the matching log lines, including `reqId` and the error code.
4. The audit trail (`/v1/admin/audit-logs?resourceId=…`) gives the business-level history of the same consultation.

## Production notes

- **Sampling:** use `OTEL_TRACES_SAMPLER=parentbased_traceidratio` with ratio 0.1 in prod (configmap) and 1.0 in staging. Tail-based sampling in the collector to keep all error and slow traces is the next step.
- **Scraping:** in Kubernetes, Prometheus scrapes through the `ServiceMonitor`. `/metrics` is never exposed through the Ingress.
- **Log retention:** 7 days in Loki (configurable). Audit logs are a separate, durable compliance store, not ordinary logs.
