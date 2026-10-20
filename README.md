# Amrutam Telemedicine Backend

A production-grade backend for Amrutam's teleconsultation platform. It covers:
- user lifecycle with **MFA and RBAC**;
- doctor discovery and availability;
- a race-free, **idempotent booking saga** with payments;
- the consultation lifecycle with encrypted **prescriptions** and async PDF generation;
- a **tamper-evident audit trail**;
- admin analytics.

The stack is Node.js 24, TypeScript, Fastify, PostgreSQL 16, Redis 7 and BullMQ, instrumented with OpenTelemetry, Prometheus, Loki and Grafana.

> **Zero cost.** Everything runs locally on free, open-source software. The payment provider is a deterministic mock behind a `PaymentGateway` port. S3 is emulated by SeaweedFS and SMTP by Mailpit. The AWS Terraform is reference infrastructure that is **never applied**: CI only runs `terraform validate`, which needs no AWS account. CI uses free GitHub Actions minutes.

| Deliverable | Where |
|---|---|
| Code + infra | `src/`, `infra/` (Docker, Compose, Terraform, Kubernetes) |
| API schema (OpenAPI 3.1) | [`docs/openapi.yaml`](docs/openapi.yaml), live at `http://localhost:3000/docs` |
| Architecture doc (diagrams, sagas, partitioning, caching, DR) | [`docs/architecture.md`](docs/architecture.md), [`docs/adr/`](docs/adr) |
| Tests + CI | `tests/` (51 unit and integration tests), `load/` (k6), [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Observability | [`docs/observability.md`](docs/observability.md), `infra/compose/*` |
| Security checklist + threat model | [`docs/security.md`](docs/security.md) |
| Demo video script | [`docs/demo-script.md`](docs/demo-script.md), runnable walkthrough [`scripts/demo.sh`](scripts/demo.sh) |

---

## Quick start

**Prerequisites:** Docker (Desktop) with about 4 GB of RAM, Node.js ≥ 24 (`nvm use`), `jq` and `curl`.

```bash
cp .env.example .env                       # dev-only sample secrets
npm ci
docker compose up -d --build               # reads .env; postgres, redis, seaweedfs, mailpit, migrate, api, worker + observability
npm run seed                               # demo users, 12 verified doctors, a week of slots
./scripts/demo.sh                          # end-to-end walkthrough of every core flow
```

| URL | What |
|---|---|
| http://localhost:3000/docs | Swagger UI (OpenAPI 3.1) |
| http://localhost:3001 | Grafana (anonymous viewer; admin / `amrutam-dev`): **Amrutam — Service Overview** |
| http://localhost:16686 | Jaeger traces |
| http://localhost:9090 | Prometheus (targets, alert rules) |
| http://localhost:8025 | Mailpit (emails sent by the worker) |

**Demo accounts** (from `npm run seed`). Doctors and admins require TOTP; `npm run totp` prints the current code.

| Role | Email | Password |
|---|---|---|
| Admin | `admin@amrutam.local` | `Admin@Amrutam2026` |
| Doctor | `dr.1@amrutam.local` … `dr.12@amrutam.local` | `Doctor@Amrutam2026` |
| Patient | `patient1@amrutam.local` … `patient5@amrutam.local` | `Patient@Amrutam2026` |

### Running the app outside Docker (hot reload)

```bash
docker compose up -d postgres redis seaweedfs mailpit
npm run migrate && npm run seed
npm run dev            # API on :3000
npm run dev:worker     # worker (jobs, outbox relay, schedulers)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `dev:worker` | Run the API and worker with tsx watch |
| `npm run build` / `start` / `start:worker` | Compile to `dist/` and run with OpenTelemetry preloaded |
| `npm run migrate` (`-- down`) | Apply or roll back migrations (advisory-locked) |
| `npm run seed` | Load demo data (idempotent) |
| `npm test` | Unit and integration tests (integration uses **Testcontainers**: Docker required) |
| `npm run test:unit` / `test:integration` / `test:coverage` | Subsets and coverage |
| `npm run lint` / `typecheck` / `format` | Code quality |
| `npm run openapi:export` | Regenerate `docs/openapi.yaml` from the route schemas |
| `npm run totp` | Current TOTP code for the demo secret |

**Load tests (k6 via Docker, free):**

```bash
RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000 BOOKING_RATE_LIMIT_MAX=100000 docker compose up -d api
docker run --rm -i --network host grafana/k6:0.57.0 run - < load/k6-read.js      # SLO: reads p95 < 200 ms
docker run --rm -i --network host grafana/k6:0.57.0 run - < load/k6-booking.js   # SLO: writes p95 < 500 ms
docker compose up -d api                                                        # restore default limits
```

Local results on one API container: **reads p95 4.5 ms at 150 rps** with 0 errors, and **contended writes p95 61 ms at 40 rps** with 0 × 5xx.

## API overview (`/v1`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/mfa/verify`, `/auth/refresh`, `/auth/logout`, `/auth/mfa/{enroll,activate,disable}` |
| Me | `GET/DELETE /me`, `PATCH /me/profile`, `GET /me/export` (DPDP right of access) |
| Discovery | `GET /doctors?q&specialty&language&city&minFee&maxFee&minRating&availableOn&sort&cursor`, `GET /doctors/{id}`, `GET /doctors/{id}/slots` |
| Doctor self-service | `PUT/GET /doctors/me`, `POST/GET /doctors/me/slots`, `PATCH/DELETE /doctors/me/slots/{slotId}` |
| Booking & payments | `POST /bookings`, `GET /payments/{id}`, `POST /payments/webhook`, `POST /payments/{id}/mock-checkout` (dev only) |
| Consultations | `GET /consultations`, `GET /consultations/{id}`, `POST /consultations/{id}/{start,complete,no-show,cancel}` |
| Prescriptions | `POST/GET /consultations/{id}/prescription`, `GET /consultations/{id}/prescription/pdf` |
| Admin | `GET /admin/doctors`, `POST /admin/doctors/{id}/verify`, `POST /admin/users/{id}/status`, `GET /admin/audit-logs`, `GET /admin/audit-logs/verify`, `GET /admin/analytics/overview`, `POST /admin/analytics/refresh` |

**Conventions:**
- `Authorization: Bearer <jwt>`.
- An **`Idempotency-Key` is required on every mutating call**. A retry with the same key replays the original response (`Idempotent-Replayed: true`).
- Errors are RFC 7807 `application/problem+json` with a stable `code` and a `requestId`.
- Lists use opaque keyset `cursor`s.

## How the rubric is covered

| Area | Highlights |
|---|---|
| **Architecture** | Modular monolith with constructor DI, transactional outbox, orchestrated saga with compensations, read/write split, partitioned audit log, DR plan. See [architecture.md](docs/architecture.md). |
| **Core flows** | All six workflows implemented end to end and exercised by `scripts/demo.sh` and the integration tests |
| **Code quality** | Strict TypeScript, Zod at every boundary, small services, typed DB layer (Kysely), lint and prettier in CI, ADRs |
| **Security** | MFA, RBAC deny-by-default, refresh-token reuse detection, AES-GCM field encryption with rotation, HMAC webhooks, hash-chained audit, hardened containers. See [security.md](docs/security.md). |
| **Idempotency** | Durable keys with fingerprinting, replay, conflict and lease semantics, plus natural-key defences (slot hold, provider idempotency keys, webhook event dedupe) |
| **Observability** | Metrics + traces + logs correlated by trace id, SLO burn-rate alerts, provisioned dashboard. See [observability.md](docs/observability.md). |
| **Scalability** | Stateless pods + HPA, keyset pagination, caching with stampede protection, read replica, rollups, sharding path, measured load tests |
| **Infra/CI** | Docker, Compose, Terraform (AWS, validated), Kustomize (validated with kubeconform), GitHub Actions with security gates |

## Repository layout

```
src/
  app.ts, server.ts, worker.ts, container.ts   # Fastify app, entrypoints, composition root (DI)
  config/env.ts                                # zod-validated environment (fail fast)
  domain/                                      # RBAC matrix, consultation state machine, errors
  plugins/                                     # auth+RBAC, idempotency, errors (RFC 7807), metrics
  infra/                                       # db, redis, cache, crypto, tokens, queue, outbox, storage, telemetry
  modules/<domain>/                            # routes + service + schemas per domain
  jobs/                                        # outbox relay, hold expiry, notifications, maintenance
  db/migrations, db/seed.ts
tests/unit, tests/integration                  # vitest; integration = real Postgres/Redis (Testcontainers)
load/                                          # k6 scripts
infra/docker | compose | terraform | k8s       # image, local stack + observability, AWS IaC, manifests
docs/                                          # architecture, security, observability, ADRs, OpenAPI, demo script
```

## Known limitations & next steps

- The payment provider is mocked. A Razorpay or Stripe adapter would implement `PaymentGateway`, using hosted checkout so card data never touches the platform.
- Video and chat for the consultation room are out of scope; integrate a provider via signed room tokens.
- The webhook secret is single-key. Support dual secrets during rotation.
- DR is backup/restore into ap-south-2 (RTO ≤ 4 h). Moving to warm standby would mean a cross-region read replica plus a pre-provisioned EKS cluster.
- Tail-based trace sampling in the collector. A per-tenant audit-chain head would be needed for very high audit write volumes.
