# ADR-0004: Durable, fingerprinted idempotency keys in PostgreSQL

**Status:** accepted

## Decision

Every mutating `/v1` call requires an `Idempotency-Key`. Keys are scoped per user and stored in Postgres with a SHA-256 fingerprint of method + route + params + body.

| Situation | Result |
|---|---|
| First request with a key | Takes a 30 s lease and runs the handler |
| Same key, same payload | Replays the stored (encrypted) response |
| Same key, different payload | 422 |
| Same key while the first is still running | 409 |
| Response is 5xx | The key is released so the client can retry |
| Holder crashed | Its lease expires and can be taken over |

## Why Postgres, not Redis

- The keys are durable across Redis failover.
- A single store means fewer failure modes.
- Business-level natural keys (the slot hold, `payment.id` as the provider idempotency key, `(provider, event_id)` for webhooks) add defence in depth for the small window between the business commit and recording the response.
