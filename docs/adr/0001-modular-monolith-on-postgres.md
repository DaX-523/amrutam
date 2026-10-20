# ADR-0001: Modular monolith + workers on PostgreSQL

**Status:** accepted

## Context

The system must handle 100k consultations/day, which is about 70 writes/s at peak. The hardest requirements are correctness under contention, idempotency, and auditability, not raw throughput.

## Decision

- A single deployable built from domain modules (`src/modules/*`), with explicit constructor-injected dependencies.
- A separate worker process, from the same image, for asynchronous work.
- PostgreSQL is the system of record, including for idempotency keys and the outbox.
- Redis is used only for ephemeral data: cache, rate limits and queues.

## Consequences

**Positive:**
- Local ACID transactions cover the core invariants: hold, consultation, payment and outbox commit together.
- One thing to deploy, observe and secure.

**Negative:**
- The modules scale together. This is mitigated by stateless pods with an HPA, a read replica, and a documented sharding path (shard by `doctor_id` with Citus).
- Module boundaries plus outbox events let a module be extracted later without changing behaviour.
