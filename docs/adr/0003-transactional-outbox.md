# ADR-0003: Transactional outbox for async side effects

**Status:** accepted

## Context

State changes must trigger emails, PDFs and refunds. Enqueueing to Redis directly from a request is a dual write: the database can commit while the enqueue fails, or the reverse.

## Decision

- Write `outbox_events` in the same transaction as the state change.
- A relay running in the workers moves events to BullMQ using `FOR UPDATE SKIP LOCKED` and deterministic job ids.
- Consumers are idempotent.
- The W3C trace context travels with each event.

## Consequences

- Delivery is at-least-once with no lost events.
- Relay latency is about 0.5 s.
- An outbox cleanup job is needed; it is implemented.
