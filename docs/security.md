# Security: Checklist & Threat Model

This system processes **health data (PHI)**. The relevant regimes are India's DPDP Act 2023, the Telemedicine Practice Guidelines 2020 and the Information Technology Act. The design treats these as hard requirements:
- least privilege everywhere;
- defence in depth around PHI;
- every access to clinical data is attributable.

## 1. Security checklist

| # | Control | Status | Where |
|---|---|---|---|
| 1 | TLS 1.2+ (TLS 1.3 policy) at the edge, HSTS (2y, preload), HTTP→HTTPS | ✅ | `infra/k8s/base/ingress.yaml`, helmet |
| 2 | Passwords: argon2id (19 MiB, t=2), ≥12 chars, ≤128, rehash-on-login | ✅ | `infra/passwords.ts` |
| 3 | User-enumeration resistance (same error + equalised timing) | ✅ | `auth.service.ts` (`verifyDummy`) |
| 4 | Account lockout (5 failures → 15 min) + per-IP auth rate limit (10/min) | ✅ | `auth.service.ts`, `auth.routes.ts` |
| 5 | **MFA (TOTP, RFC 6238)**, mandatory for doctors and admins, replay-protected | ✅ | `auth.service.ts`, `plugins/auth.ts` |
| 6 | Short-lived JWT (15 min, HS256 with `kid` keyring, `alg` pinned, iss/aud checked, token-type confusion prevented) | ✅ | `infra/tokens.ts` |
| 7 | Refresh-token rotation + **reuse detection → family revocation**; tokens stored as SHA-256 | ✅ | `auth.service.ts` |
| 8 | Immediate session kill (suspension, logout, MFA upgrade) via Redis denylist | ✅ | `session-revocations.ts` |
| 9 | **RBAC deny-by-default** + ownership checks (404 on foreign resources) | ✅ | `rbac-policy.ts`, services |
| 10 | Admins have **no PHI permissions** (separation of duties) | ✅ | `rbac-policy.ts` |
| 11 | Input validation: strict Zod schemas (unknown keys rejected), size caps, body limit 256 KB | ✅ | `*.schemas.ts`, `app.ts` |
| 12 | Output filtering: response schemas serialise only declared fields | ✅ | fastify-type-provider-zod |
| 13 | SQL injection: parameterised queries only (Kysely / tagged `sql`) | ✅ | everywhere |
| 14 | **Idempotency** on every mutating endpoint (fail-closed: 400 without key) | ✅ | `plugins/idempotency.ts` |
| 15 | Rate limiting: global per user/IP, stricter on auth and booking; WAF rate rule at the edge | ✅ | `app.ts`, `security.tf` |
| 16 | Business-abuse limits: ≤3 unpaid holds per patient, ≤500 slots per request, 14-day windows | ✅ | services |
| 17 | **Field-level encryption** of PHI (AES-256-GCM, AAD-bound, versioned keys) + KMS at rest | ✅ | `infra/crypto.ts`, Terraform |
| 18 | Blind index for equality search on encrypted phone numbers | ✅ | `crypto.ts` |
| 19 | Webhooks: HMAC-SHA256 over timestamp+raw body, 5-min window, constant-time compare, event dedupe, amount check | ✅ | `payments/gateway.ts`, `payments.service.ts` |
| 20 | **Tamper-evident, append-only audit trail** (hash chain + triggers + verification API) | ✅ | migration 0002, `audit.service.ts` |
| 21 | PHI-free logs (pino redaction), PHI-free emails, generic error bodies (RFC 7807, request id only) | ✅ | `logger.ts`, `error-handler.ts` |
| 22 | `Cache-Control: no-store` on authenticated responses; security headers (helmet) | ✅ | `plugins/auth.ts`, `app.ts` |
| 23 | CORS allow-list; no cookies (bearer tokens), so no CSRF surface | ✅ | `app.ts` |
| 24 | Secrets only via env (validated at boot, never logged); prod via Secrets Manager + External Secrets | ✅ | `config/env.ts`, `externalsecret.yaml` |
| 25 | Container hardening: non-root, read-only rootfs, all capabilities dropped, seccomp, no npm in runtime image | ✅ | Dockerfile, K8s manifests |
| 26 | Network: default-deny NetworkPolicies, private subnets for data stores, VPC endpoints, private EKS API | ✅ | `networkpolicy.yaml`, Terraform |
| 27 | Supply chain: lockfile, `npm audit`, OSV-Scanner, Trivy (image + IaC), CodeQL, gitleaks, Dependabot | ✅ | `.github/workflows/ci.yml` |
| 28 | Data-subject rights: export (`GET /v1/me/export`), erasure with clinical-record retention | ✅ | `users.service.ts` |
| 29 | Consent captured with policy version at registration | ✅ | `profiles.consent_version` |
| 30 | Dev-only endpoints disabled in production (`MOCK_CHECKOUT_ENABLED=false`) | ✅ | configmap |

## 2. Data classification

| Class | Examples | Storage controls | Access controls |
|---|---|---|---|
| **Restricted: PHI** | consultation reason & clinical notes, prescriptions, DOB, TOTP secrets | AES-256-GCM field encryption (app keyring) **and** KMS volume/backup encryption; never logged; no PHI in emails | Treating doctor and the patient only. Every read is audited, including denied attempts. Admins have no access. |
| **Confidential: PII** | name, email, phone | phone encrypted + blind index; email plaintext (login key) | Owner, plus the assigned doctor (name only) |
| **Financial** | payment/order ids, amounts, refund ids | no card data ever touches us (hosted checkout keeps us out of PCI DSS scope) | Owner and the system |
| **Internal** | audit logs, metrics, traces | append-only and hash-chained; traces scrub auth headers and hash SQL | Admins (`admin:audit`), SREs |
| **Public** | verified doctor profiles, open slots | cacheable | Anyone (rate limited) |

## 3. Attack surface

| Entry point | Exposure | Key mitigations |
|---|---|---|
| `POST /v1/auth/*` | Internet, unauthenticated | per-IP rate limit, lockout, argon2id, enumeration resistance, WAF |
| `GET /v1/doctors*` (search, slots) | Internet, unauthenticated | strict query validation, pagination caps, statement timeout (5 s), cache, WAF rate rule |
| Authenticated `/v1/*` | Internet, JWT | RBAC, ownership checks, MFA for privileged roles, idempotency, per-user limits |
| `POST /v1/payments/webhook` | Internet (provider) | HMAC + timestamp, dedupe, amount verification, schema validation |
| `/metrics`, `/health/*` | Cluster-internal only | not routed by the Ingress; NetworkPolicy allows only the `observability` namespace |
| Admin API | Internet, admin JWT + MFA | separate permission set, every action audited; IP allow-listing via WAF recommended |
| Workers | No inbound (metrics only) | consume only from the internal outbox; payloads hold ids, not PHI |
| Data stores | Private subnets only | SGs from EKS nodes only, TLS, auth tokens, KMS |
| CI/CD | GitHub | least-privilege `GITHUB_TOKEN`, pinned action majors, environment protection on deploy, secret scanning |
| Third-party code | npm dependencies | lockfile, audits, OSV, Dependabot, minimal runtime image |

## 4. Threat model (STRIDE)

| Component | Threat | Scenario | Mitigation |
|---|---|---|---|
| Auth | **S**poofing | Credential stuffing or phishing of a doctor account | MFA mandatory for doctors/admins, lockout, rate limit, WAF IP reputation list, login-failure alert |
| Auth | **S**poofing | Stolen refresh token | Rotation + reuse detection revokes the whole family; alert on reuse |
| Auth | **E**levation | Self-registering as admin; mass-assigning `role` | Register accepts only `patient`/`doctor`; strict schemas reject unknown fields |
| API | **E**levation | Patient calls a doctor or admin route | Permission matrix checked before the handler (deny by default) |
| API | **I**nfo disclosure | IDOR: patient reads another patient's consultation | Ownership check in the service; returns 404 (not 403); denied attempt audited |
| API | **T**ampering | Lost update when two doctors' devices edit the same consultation | `SELECT … FOR UPDATE` + `expectedVersion` optimistic locking |
| Booking | **D**oS / abuse | Bot hoards all slots of a popular doctor | ≤3 unpaid holds per patient, 10-min hold TTL, per-user booking rate limit |
| Booking | **T**ampering | Double booking through races or retries | Atomic conditional update + partial unique index + idempotency keys |
| Payments | **S**poofing | Forged "payment captured" webhook | HMAC over timestamp+raw body, constant-time compare, 5-min window |
| Payments | **R**epudiation / replay | Re-sent webhook | `(provider, event_id)` primary key; state-based no-ops |
| Payments | **T**ampering | Paying less than the fee | Webhook amount compared to the stored amount; mismatch triggers auto-refund and no booking |
| Data at rest | **I**nfo disclosure | DB snapshot or backup leak, SQL access by an insider | PHI encrypted in the application with keys outside the DB; KMS on volumes/backups; AAD prevents ciphertext transplanting |
| Logs/traces | **I**nfo disclosure | PHI or tokens in logs | pino redaction paths, collector scrubs `authorization` and hashes `db.statement`, PHI-free error messages |
| Audit | **R**epudiation / tampering | Insider edits or deletes the audit trail | Append-only triggers, hash chain with gapless sequence, `/admin/audit-logs/verify`; prod: separate DB role without DDL rights and partitions archived to WORM (S3 Object Lock) |
| Infra | **D**oS | Volumetric or L7 floods | WAF managed rules + rate rule, HPA, statement timeouts, circuit breaker, body limits |
| Infra | **E**levation | Container escape / lateral movement | Non-root, read-only, no capabilities, seccomp, restricted PSA, default-deny NetworkPolicies, IRSA least privilege |
| Supply chain | **T**ampering | Malicious dependency | Lockfile + `npm ci`, OSV/npm audit/Trivy gates, Dependabot review, CodeQL; npm removed from the runtime image |

## 5. OWASP mapping

**OWASP API Security Top 10 (2023)**

| Risk | Mitigation |
|---|---|
| API1 Broken Object Level Authorization | Ownership enforced in every service query (`patient_id`/`doctor_id`), 404 on mismatch, audited; integration-tested |
| API2 Broken Authentication | argon2id, MFA, lockout, short-lived JWT, rotation + reuse detection, revocation |
| API3 Broken Object Property Level Authorization | Strict request schemas (`.strict()`), response schemas whitelist fields, list endpoints omit PHI |
| API4 Unrestricted Resource Consumption | Rate limits (user/IP/route), pagination ≤100, body ≤256 KB, slot generation caps, DB statement timeout |
| API5 Broken Function Level Authorization | Central permission matrix on every route config; admin routes need `admin:*` + MFA |
| API6 Unrestricted Access to Sensitive Business Flows | Hold caps, booking rate limit, payment required to confirm, late captures refunded |
| API7 Server Side Request Forgery | The service never fetches user-supplied URLs |
| API8 Security Misconfiguration | helmet headers, CORS allow-list, no stack traces, hardened containers, IaC scanning in CI |
| API9 Improper Inventory Management | Generated OpenAPI with a drift check, `/v1` versioning, dev endpoints feature-flagged off in prod |
| API10 Unsafe Consumption of APIs | Provider webhooks authenticated + schema-validated + amount-verified; timeouts/circuit breaker on outbound calls |

**OWASP Top 10 (2021)**

| Risk | Mitigations (summary) |
|---|---|
| A01 Broken Access Control | API1/API5 above |
| A02 Cryptographic Failures | TLS, AES-GCM with AAD, KMS, argon2id, no homegrown crypto |
| A03 Injection | Parameterised SQL |
| A04 Insecure Design | Threat model, abuse limits |
| A05 Security Misconfiguration | Same as API8 |
| A06 Vulnerable Components | Scanners + Dependabot |
| A07 Identification & Authentication Failures | MFA, lockout |
| A08 Software & Data Integrity Failures | Signed webhooks, hash-chained audit, `npm ci` from lockfile, image scanning |
| A09 Security Logging & Monitoring Failures | Audit trail + security alerts (login spikes, token reuse, webhook forgery) |
| A10 SSRF | N/A by design |

## 6. Encryption & key management

| Layer | Mechanism |
|---|---|
| In transit | TLS 1.3 at the ALB; TLS to RDS (`rds.force_ssl=1`) and ElastiCache (transit encryption); S3 bucket policy denies non-TLS |
| At rest (infra) | KMS CMKs per domain (rds, redis, s3, secrets, eks, backup), **automatic yearly rotation** |
| At rest (application, PHI) | AES-256-GCM, 96-bit random IV, 128-bit tag. Envelope `enc:<keyId>:<iv\|tag\|ct>`. AAD = `table.column` |
| Passwords | argon2id |
| Tokens | Refresh tokens and idempotency fingerprints stored as SHA-256; MFA secrets encrypted |

**Rotation runbooks** (no downtime):

1. **PHI field key**
   1. Add `k2` to `ENCRYPTION_KEYS` and deploy (both keys can decrypt).
   2. Set `ENCRYPTION_ACTIVE_KEY_ID=k2` and deploy (new writes use k2).
   3. Run the `key-rotation` job, or wait for the nightly run. It re-encrypts in batches with compare-and-swap and reports remaining rows per column.
   4. When the report is 0 and ≥24 h have passed (stored idempotency responses expire), remove `k1`.
2. **JWT signing key**
   1. Add the new `kid` and deploy.
   2. Switch `JWT_ACTIVE_KID`.
   3. After 15 min (one access TTL), remove the old key. Refresh tokens are opaque, so they are unaffected.
3. **DB credentials:** RDS-managed rotation in Secrets Manager. External Secrets refreshes every 15 min, and the pool reconnects.
4. **Webhook secret:** coordinate with the provider. A dual-secret window (accept both) is the planned enhancement.
5. **Blind-index key:** requires recomputing `phone_bidx` (a batch job). Rotate only on compromise.

## 7. Audit logging

- **What:** every authentication event (success, failure, lockout, MFA, refresh-token reuse), every state change, every **PHI read** (consultation, prescription, PDF, data export), admin actions, and system compensations (expired holds).
- **Fields:** actor, role, action, resource, outcome (`success`/`denied`/`failure`), IP, user agent, request id, trace id. `metadata` holds non-PHI context only.
- **Integrity:**
  - Monthly partitions.
  - UPDATE/DELETE/TRUNCATE are blocked by triggers.
  - Each row is `sha256(prev_hash | fields)` with a gapless `chain_seq`.
  - `GET /v1/admin/audit-logs/verify` recomputes the chain and reports the first broken link. The integration tests prove tampering is detected.
- **Production hardening:** the app connects as a role with only `INSERT, SELECT` on `audit_logs`. Closed partitions are exported to S3 with Object Lock (compliance mode), and chain-head hashes are periodically anchored externally.

## 8. Dependency & code scanning (CI gates)

| Tool | Gate |
|---|---|
| `npm audit --omit=dev --audit-level=high` | Fails on high/critical production advisories (currently 0) |
| OSV-Scanner (lockfile) | Fails on known vulnerabilities (currently 0) |
| Trivy image | Fails on fixable HIGH/CRITICAL (currently 0, after removing npm from the runtime image) |
| Trivy config | Fails on HIGH/CRITICAL misconfigurations in Terraform/K8s/Dockerfile. One justified exception in `.trivyignore` |
| CodeQL (`security-extended`) | SAST on TypeScript |
| gitleaks | Secret scanning across git history (dev sample keys allow-listed and documented) |
| Dependabot | Weekly update PRs for npm, Actions, Docker, Terraform |

A finding during development: `awilix` pulled in a vulnerable `braces` release with no available fix. Instead of accepting the risk, the project uses a hand-written, typed composition root (`src/container.ts`).

## 9. Incident response (summary)

1. **Detect.** Security alerts (`LoginFailureSpike`, `RefreshTokenReuse`, `WebhookSignatureFailures`) and audit anomalies.
2. **Contain.** Suspend the account (kills sessions instantly), rotate the affected keys (runbooks above), and block at the WAF.
3. **Investigate.** Use the audit trail by actor or resource, correlated through request id → trace → logs.
4. **Notify.** Inform the Data Protection Board and affected principals as the DPDP Act requires.
5. **Learn.** Hold a post-mortem and add regression tests.
