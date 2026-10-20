# 5-minute demo video script

**Setup before recording:**
1. Run `docker compose up -d --build`, then `npm run seed`.
2. Open four browser tabs: Swagger (`localhost:3000/docs`), Grafana (`localhost:3001`), Jaeger (`localhost:16686`) and Mailpit (`localhost:8025`).
3. Keep a terminal ready at the repo root.

| Time | Show | Say |
|---|---|---|
| 0:00–0:30 | README and the architecture diagram in `docs/architecture.md` | Modular Fastify monolith plus workers on Postgres, Redis and BullMQ, built for 100k consultations/day, 99.95 % availability and the p95 SLOs. Everything runs free and locally. |
| 0:30–1:00 | Swagger `/docs` | The OpenAPI 3.1 spec is generated from Zod schemas, with a CI drift check. Every write takes an Idempotency-Key, and errors are RFC 7807. |
| 1:00–2:45 | Terminal: `./scripts/demo.sh` (pause at each ▶) | 1. **Search** (full-text, filters, keyset cursors). 2. **Doctor MFA login** (password + TOTP). 3. **Race:** two patients book the same slot and exactly one wins, enforced by the atomic conditional update. 4. **Idempotency:** the replay header appears, and a different payload gets 422. 5. **Payment webhook:** HMAC-verified, confirms the booking; a forged signature gets 401. 6. **IDOR:** another patient gets 404, and the attempt is audited. 7. **Lifecycle:** start, prescribe (encrypted), stale `expectedVersion` gets 409, then complete. 8. **Async PDF** rendered by the worker and downloaded. 9. **Cancel with refund.** 10. **Admin:** analytics plus audit chain verification. |
| 2:45–3:15 | `docker compose exec postgres psql -U amrutam -c "select reason_enc from consultations limit 1"`, then `… -c "update audit_logs set action='x'"` | PHI is ciphertext at rest (AES-256-GCM, AAD-bound, rotatable keys). The audit log is append-only and hash-chained. |
| 3:15–4:00 | Grafana dashboard; Jaeger trace of `POST /v1/bookings`, then a worker job span in the same trace; Mailpit inbox | RED metrics and SLO stats, the booking funnel, queues/DLQ, burn-rate alerts. The trace crosses API → Postgres → outbox → worker. Logs link to traces. Emails contain no PHI. |
| 4:00–4:30 | `npm test` output (51 tests) and `.github/workflows/ci.yml` | Testcontainers integration tests, including the 50-way booking race, webhook dedupe, saga compensation and tamper detection. CI runs lint, tests, CodeQL, OSV, gitleaks, Trivy and terraform validate, then builds the image. |
| 4:30–5:00 | `infra/terraform`, `infra/k8s`, `docs/security.md` | Reference AWS (Multi-AZ RDS + replica, PITR, cross-region DR, KMS, WAF) and hardened Kubernetes manifests. Security doc with STRIDE, OWASP mapping and key-rotation runbooks. Close with trade-offs and next steps. |

**Useful one-liners:**
- `npm run totp` prints the current demo TOTP code.
- `docker compose logs -f worker` tails the worker logs.
- `k6`: `docker run --rm -i --network host grafana/k6:0.57.0 run - < load/k6-read.js`
