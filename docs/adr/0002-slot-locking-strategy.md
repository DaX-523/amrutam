# ADR-0002: Atomic conditional update for slot booking

**Status:** accepted

## Options considered

1. Redis distributed lock (Redlock) around the booking.
2. `SERIALIZABLE` transactions.
3. `SELECT … FOR UPDATE` followed by an update.
4. **A single conditional `UPDATE … WHERE status = 'available' RETURNING`.**

## Decision

Option 4, with a partial unique index (`one live consultation per slot`) as a backstop and the `EXCLUDE` constraint against overlapping slots.

## Why

- **One round trip.** A row lock plus a predicate re-check (EvalPlanQual) guarantees exactly one winner.
- **Losers fail fast.** They get a 409 and never queue behind the winner's whole transaction.
- **No extra infrastructure.** Unlike Redlock, correctness does not depend on clocks or failover.
- **No retry storms.** Unlike `SERIALIZABLE`, losers are not hit with serialization failures and retries.

## Verification

An integration test fires 50 concurrent bookings at the same slot. Exactly 1 gets 201, 49 get 409, and there is exactly one live consultation.
