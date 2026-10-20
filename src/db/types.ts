import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type UserRole = 'patient' | 'doctor' | 'admin';
export type UserStatus = 'active' | 'suspended' | 'deleted';
export type SlotStatus = 'available' | 'held' | 'booked' | 'blocked';
export type ConsultationStatus =
  'pending_payment' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
export type PaymentStatus = 'initiated' | 'captured' | 'failed' | 'expired' | 'refund_pending' | 'refunded';
export type ArtifactStatus = 'pending' | 'ready' | 'failed';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  role: UserRole;
  status: Generated<UserStatus>;
  mfa_enabled: Generated<boolean>;
  mfa_secret_enc: string | null;
  mfa_last_timestep: ColumnType<string | null, number | string | null, number | string | null>;
  failed_login_attempts: Generated<number>;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  deleted_at: Timestamp | null;
}

export interface ProfilesTable {
  user_id: string;
  full_name: string;
  phone_enc: string | null;
  phone_bidx: string | null;
  dob_enc: string | null;
  gender: 'female' | 'male' | 'other' | 'undisclosed' | null;
  city: string | null;
  consent_version: string | null;
  consent_given_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: DefaultTimestamp;
}

export interface DoctorsTable {
  user_id: string;
  display_name: string;
  registration_number: string;
  specialties: string[];
  languages: Generated<string[]>;
  qualifications: Generated<string[]>;
  years_experience: Generated<number>;
  fee_paise: number;
  city: string | null;
  bio: string | null;
  rating: ColumnType<string, number | string | undefined, number | string>;
  rating_count: Generated<number>;
  verified_at: Timestamp | null;
  verified_by: string | null;
  search_tsv: ColumnType<unknown, never, never>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface AvailabilitySlotsTable {
  id: Generated<string>;
  doctor_id: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: Generated<SlotStatus>;
  held_by: string | null;
  hold_expires_at: Timestamp | null;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface ConsultationsTable {
  id: Generated<string>;
  patient_id: string;
  doctor_id: string;
  slot_id: string;
  status: Generated<ConsultationStatus>;
  scheduled_at: Timestamp;
  ends_at: Timestamp;
  fee_paise: number;
  reason_enc: string | null;
  notes_enc: string | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  version: Generated<number>;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PrescriptionsTable {
  id: Generated<string>;
  consultation_id: string;
  doctor_id: string;
  patient_id: string;
  items_enc: string;
  advice_enc: string | null;
  follow_up_date: ColumnType<string | null, string | null, string | null>;
  content_hash: string;
  pdf_status: Generated<ArtifactStatus>;
  pdf_object_key: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PaymentsTable {
  id: Generated<string>;
  consultation_id: string;
  patient_id: string;
  amount_paise: number;
  currency: Generated<string>;
  status: Generated<PaymentStatus>;
  provider: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_refund_id: string | null;
  failure_reason: string | null;
  captured_at: Timestamp | null;
  refunded_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PaymentWebhookEventsTable {
  provider: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  received_at: DefaultTimestamp;
}

export interface AuditLogsTable {
  id: ColumnType<string, never, never>;
  occurred_at: DefaultTimestamp;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'denied' | 'failure';
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  trace_id: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, never>;
  chain_seq: ColumnType<string, never, never>;
  prev_hash: ColumnType<string | null, never, never>;
  hash: ColumnType<string, never, never>;
}

export interface IdempotencyKeysTable {
  scope: string;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: string | null;
  locked_until: Timestamp;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
}

export interface OutboxEventsTable {
  id: ColumnType<string, never, never>;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: ColumnType<Record<string, unknown>, string, string>;
  trace_context: ColumnType<Record<string, string> | null, string | null, string | null>;
  created_at: DefaultTimestamp;
  published_at: Timestamp | null;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface AnalyticsDailyTable {
  day: ColumnType<string, string, string>;
  metric: string;
  dimension: Generated<string>;
  value: ColumnType<string, number | string, number | string>;
  computed_at: DefaultTimestamp;
}

export interface Database {
  users: UsersTable;
  profiles: ProfilesTable;
  refresh_tokens: RefreshTokensTable;
  doctors: DoctorsTable;
  availability_slots: AvailabilitySlotsTable;
  consultations: ConsultationsTable;
  prescriptions: PrescriptionsTable;
  payments: PaymentsTable;
  payment_webhook_events: PaymentWebhookEventsTable;
  audit_logs: AuditLogsTable;
  idempotency_keys: IdempotencyKeysTable;
  outbox_events: OutboxEventsTable;
  analytics_daily: AnalyticsDailyTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Profile = Selectable<ProfilesTable>;
export type Doctor = Selectable<DoctorsTable>;
export type Slot = Selectable<AvailabilitySlotsTable>;
export type Consultation = Selectable<ConsultationsTable>;
export type Prescription = Selectable<PrescriptionsTable>;
export type Payment = Selectable<PaymentsTable>;
export type AuditLog = Selectable<AuditLogsTable>;
