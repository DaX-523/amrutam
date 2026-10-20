import { sql, type Kysely } from 'kysely';

/**
 * Compliance + platform tables:
 *  - audit_logs: append-only, monthly range partitions, SHA-256 hash chain (tamper evidence)
 *  - idempotency_keys: durable idempotency for all mutating API calls
 *  - outbox_events: transactional outbox feeding the async job system
 *  - analytics_daily: pre-aggregated rollups for admin dashboards
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- ───────────────────────── audit trail ─────────────────────────
    CREATE TABLE audit_logs (
      id            bigint GENERATED ALWAYS AS IDENTITY,
      occurred_at   timestamptz NOT NULL DEFAULT now(),
      actor_id      uuid,
      actor_role    text,
      action        text NOT NULL,
      resource_type text NOT NULL,
      resource_id   text,
      outcome       text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
      ip            inet,
      user_agent    text,
      request_id    text,
      trace_id      text,
      metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
      chain_seq     bigint NOT NULL,
      prev_hash     text,
      hash          text NOT NULL,
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);

    CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, occurred_at DESC);
    CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, occurred_at DESC);
    CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);
    CREATE INDEX audit_logs_chain_seq_idx ON audit_logs (chain_seq);

    CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

    -- Creates the monthly partition containing the given timestamp (idempotent).
    CREATE OR REPLACE FUNCTION ensure_audit_partition(p_month timestamptz) RETURNS text AS $$
    DECLARE
      start_ts timestamptz := date_trunc('month', p_month AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      end_ts   timestamptz := start_ts + interval '1 month';
      part     text := format('audit_logs_%s', to_char(start_ts AT TIME ZONE 'UTC', 'YYYY_MM'));
    BEGIN
      IF to_regclass(part) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
                       part, start_ts, end_ts);
      END IF;
      RETURN part;
    END $$ LANGUAGE plpgsql;

    SELECT ensure_audit_partition(now() - interval '1 month');
    SELECT ensure_audit_partition(now());
    SELECT ensure_audit_partition(now() + interval '1 month');
    SELECT ensure_audit_partition(now() + interval '2 month');

    -- Single-row chain head. Locking it serialises chain appends (O(1), short-held) and
    -- hands out a gapless sequence so verification can walk the chain in append order.
    CREATE TABLE audit_chain_head (
      id        int PRIMARY KEY CHECK (id = 1),
      last_seq  bigint NOT NULL,
      last_hash text
    );
    INSERT INTO audit_chain_head (id, last_seq, last_hash) VALUES (1, 0, NULL);

    CREATE OR REPLACE FUNCTION audit_canonical(
      p_prev text, p_at timestamptz, p_actor uuid, p_action text, p_rtype text,
      p_rid text, p_outcome text, p_meta jsonb
    ) RETURNS text AS $$
      SELECT encode(digest(
        coalesce(p_prev, 'GENESIS') || '|' ||
        to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
        coalesce(p_actor::text, '-') || '|' || p_action || '|' || p_rtype || '|' ||
        coalesce(p_rid, '-') || '|' || p_outcome || '|' || p_meta::text,
      'sha256'), 'hex')
    $$ LANGUAGE sql IMMUTABLE;

    CREATE OR REPLACE FUNCTION audit_logs_chain() RETURNS trigger AS $$
    DECLARE head text; seq bigint;
    BEGIN
      SELECT last_hash, last_seq INTO head, seq FROM audit_chain_head WHERE id = 1 FOR UPDATE;
      NEW.chain_seq := seq + 1;
      NEW.prev_hash := head;
      NEW.hash := audit_canonical(head, NEW.occurred_at, NEW.actor_id, NEW.action, NEW.resource_type,
                                  NEW.resource_id, NEW.outcome, NEW.metadata);
      UPDATE audit_chain_head SET last_hash = NEW.hash, last_seq = NEW.chain_seq WHERE id = 1;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();

    -- Append-only: no UPDATE/DELETE/TRUNCATE through the application role.
    CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
    CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

    -- ───────────────────────── idempotency ─────────────────────────
    CREATE TABLE idempotency_keys (
      scope           text NOT NULL,
      key             text NOT NULL,
      method          text NOT NULL,
      path            text NOT NULL,
      request_hash    text NOT NULL,
      status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
      response_status int,
      response_body   text,
      locked_until    timestamptz NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

    -- ───────────────────────── transactional outbox ─────────────────────────
    CREATE TABLE outbox_events (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      aggregate_type text NOT NULL,
      aggregate_id   text NOT NULL,
      event_type     text NOT NULL,
      payload        jsonb NOT NULL,
      trace_context  jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      published_at   timestamptz,
      attempts       int NOT NULL DEFAULT 0,
      last_error     text
    );
    CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

    -- ───────────────────────── analytics rollups ─────────────────────────
    CREATE TABLE analytics_daily (
      day         date NOT NULL,
      metric      text NOT NULL,
      dimension   text NOT NULL DEFAULT '',
      value       numeric NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (day, metric, dimension)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS analytics_daily, outbox_events, idempotency_keys, audit_chain_head, audit_logs CASCADE;
    DROP FUNCTION IF EXISTS audit_logs_immutable, audit_logs_chain, audit_canonical, ensure_audit_partition CASCADE;
  `.execute(db);
}
