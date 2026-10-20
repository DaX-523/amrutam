import { sql, type Kysely } from 'kysely';

/**
 * Core schema. Written as raw SQL on purpose: constraints (EXCLUDE, partial unique
 * indexes, triggers) are the real guardians of correctness under concurrency and
 * should be reviewed as SQL, not hidden behind a builder.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');
    CREATE TYPE user_status AS ENUM ('active', 'suspended', 'deleted');
    CREATE TYPE slot_status AS ENUM ('available', 'held', 'booked', 'blocked');
    CREATE TYPE consultation_status AS ENUM
      ('pending_payment', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
    CREATE TYPE payment_status AS ENUM
      ('initiated', 'captured', 'failed', 'expired', 'refund_pending', 'refunded');
    CREATE TYPE artifact_status AS ENUM ('pending', 'ready', 'failed');

    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

    -- ───────────────────────── users & profiles ─────────────────────────
    CREATE TABLE users (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                 text NOT NULL,
      password_hash         text NOT NULL,
      role                  user_role NOT NULL,
      status                user_status NOT NULL DEFAULT 'active',
      mfa_enabled           boolean NOT NULL DEFAULT false,
      mfa_secret_enc        text,
      mfa_last_timestep     bigint,
      failed_login_attempts int NOT NULL DEFAULT 0,
      locked_until          timestamptz,
      last_login_at         timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      deleted_at            timestamptz,
      CONSTRAINT users_email_lowercase CHECK (email = lower(email))
    );
    CREATE UNIQUE INDEX users_email_uq ON users (email);
    CREATE INDEX users_role_idx ON users (role, created_at);
    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE profiles (
      user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full_name        text NOT NULL,
      phone_enc        text,
      phone_bidx       text,
      dob_enc          text,
      gender           text CHECK (gender IN ('female', 'male', 'other', 'undisclosed')),
      city             text,
      consent_version  text,
      consent_given_at timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX profiles_phone_bidx_idx ON profiles (phone_bidx) WHERE phone_bidx IS NOT NULL;
    CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE refresh_tokens (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      family_id   uuid NOT NULL,
      token_hash  text NOT NULL,
      expires_at  timestamptz NOT NULL,
      revoked_at  timestamptz,
      replaced_by uuid,
      ip          inet,
      user_agent  text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
    CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
    CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

    -- ───────────────────────── doctors & availability ─────────────────────────
    CREATE TABLE doctors (
      user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name        text NOT NULL,
      registration_number text NOT NULL,
      specialties         text[] NOT NULL CHECK (cardinality(specialties) > 0),
      languages           text[] NOT NULL DEFAULT '{}',
      qualifications      text[] NOT NULL DEFAULT '{}',
      years_experience    int NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
      fee_paise           int NOT NULL CHECK (fee_paise > 0),
      city                text,
      bio                 text,
      rating              numeric(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
      rating_count        int NOT NULL DEFAULT 0,
      verified_at         timestamptz,
      verified_by         uuid REFERENCES users(id),
      search_tsv          tsvector,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX doctors_registration_uq ON doctors (registration_number);
    CREATE INDEX doctors_search_tsv_idx ON doctors USING gin (search_tsv);
    CREATE INDEX doctors_specialties_idx ON doctors USING gin (specialties);
    CREATE INDEX doctors_languages_idx ON doctors USING gin (languages);
    CREATE INDEX doctors_name_trgm_idx ON doctors USING gin (display_name gin_trgm_ops);
    CREATE INDEX doctors_city_fee_idx ON doctors (lower(city), fee_paise) WHERE verified_at IS NOT NULL;
    CREATE INDEX doctors_rating_idx ON doctors (rating DESC, user_id) WHERE verified_at IS NOT NULL;

    CREATE OR REPLACE FUNCTION doctors_search_tsv() RETURNS trigger AS $$
    BEGIN
      NEW.search_tsv :=
        setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A') ||
        setweight(to_tsvector('simple', array_to_string(NEW.specialties, ' ')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW.city, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.bio, '')), 'C');
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE TRIGGER doctors_search_tsv BEFORE INSERT OR UPDATE ON doctors
      FOR EACH ROW EXECUTE FUNCTION doctors_search_tsv();
    CREATE TRIGGER doctors_updated_at BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE availability_slots (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      doctor_id       uuid NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
      starts_at       timestamptz NOT NULL,
      ends_at         timestamptz NOT NULL,
      status          slot_status NOT NULL DEFAULT 'available',
      held_by         uuid REFERENCES users(id),
      hold_expires_at timestamptz,
      version         int NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT slot_time_order CHECK (ends_at > starts_at),
      CONSTRAINT slot_hold_consistency CHECK ((status = 'held') = (hold_expires_at IS NOT NULL)),
      -- A doctor can never have two overlapping slots.
      CONSTRAINT slot_no_overlap EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
    );
    CREATE INDEX slots_doctor_time_idx ON availability_slots (doctor_id, starts_at);
    CREATE INDEX slots_available_idx ON availability_slots (doctor_id, starts_at) WHERE status = 'available';
    CREATE INDEX slots_hold_expiry_idx ON availability_slots (hold_expires_at) WHERE status = 'held';
    CREATE TRIGGER slots_updated_at BEFORE UPDATE ON availability_slots
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ───────────────────────── consultations, prescriptions, payments ─────────────────────────
    CREATE TABLE consultations (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      patient_id    uuid NOT NULL REFERENCES users(id),
      doctor_id     uuid NOT NULL REFERENCES doctors(user_id),
      slot_id       uuid NOT NULL REFERENCES availability_slots(id),
      status        consultation_status NOT NULL DEFAULT 'pending_payment',
      scheduled_at  timestamptz NOT NULL,
      ends_at       timestamptz NOT NULL,
      fee_paise     int NOT NULL,
      reason_enc    text,
      notes_enc     text,
      started_at    timestamptz,
      completed_at  timestamptz,
      cancelled_at  timestamptz,
      cancelled_by  uuid REFERENCES users(id),
      cancel_reason text,
      version       int NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    -- Last line of defence against double booking: one live consultation per slot.
    CREATE UNIQUE INDEX consultations_live_slot_uq ON consultations (slot_id)
      WHERE status NOT IN ('cancelled');
    CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_at DESC, id);
    CREATE INDEX consultations_doctor_idx ON consultations (doctor_id, scheduled_at DESC, id);
    CREATE INDEX consultations_status_time_idx ON consultations (status, scheduled_at);
    CREATE TRIGGER consultations_updated_at BEFORE UPDATE ON consultations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE prescriptions (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      consultation_id uuid NOT NULL REFERENCES consultations(id),
      doctor_id       uuid NOT NULL REFERENCES doctors(user_id),
      patient_id      uuid NOT NULL REFERENCES users(id),
      items_enc       text NOT NULL,
      advice_enc      text,
      follow_up_date  date,
      content_hash    text NOT NULL,
      pdf_status      artifact_status NOT NULL DEFAULT 'pending',
      pdf_object_key  text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX prescriptions_consultation_uq ON prescriptions (consultation_id);
    CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);
    CREATE TRIGGER prescriptions_updated_at BEFORE UPDATE ON prescriptions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE payments (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      consultation_id     uuid NOT NULL REFERENCES consultations(id),
      patient_id          uuid NOT NULL REFERENCES users(id),
      amount_paise        int NOT NULL CHECK (amount_paise > 0),
      currency            char(3) NOT NULL DEFAULT 'INR',
      status              payment_status NOT NULL DEFAULT 'initiated',
      provider            text NOT NULL,
      provider_order_id   text,
      provider_payment_id text,
      provider_refund_id  text,
      failure_reason      text,
      captured_at         timestamptz,
      refunded_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX payments_consultation_uq ON payments (consultation_id);
    CREATE UNIQUE INDEX payments_provider_order_uq ON payments (provider, provider_order_id)
      WHERE provider_order_id IS NOT NULL;
    CREATE INDEX payments_status_idx ON payments (status, created_at);
    CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Webhook de-duplication: providers deliver at-least-once.
    CREATE TABLE payment_webhook_events (
      provider    text NOT NULL,
      event_id    text NOT NULL,
      event_type  text NOT NULL,
      payload     jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, event_id)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS payment_webhook_events, payments, prescriptions, consultations,
      availability_slots, doctors, refresh_tokens, profiles, users CASCADE;
    DROP FUNCTION IF EXISTS doctors_search_tsv, set_updated_at CASCADE;
    DROP TYPE IF EXISTS artifact_status, payment_status, consultation_status, slot_status, user_status, user_role;
  `.execute(db);
}
