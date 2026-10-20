import type { Consultation } from '../../db/types.js';
import type { FieldCipher } from '../../infra/crypto.js';
import { iso } from '../common/schemas.js';
import type { ConsultationDto } from './consultations.schemas.js';

export const CONSULTATION_AAD = { reason: 'consultations.reason', notes: 'consultations.notes' } as const;

export type ConsultationRow = Consultation & {
  patient_name?: string | null;
  doctor_name?: string | null;
  payment_status?: string | null;
};

export function toConsultationDto(row: ConsultationRow, cipher: FieldCipher | null): ConsultationDto {
  return {
    id: row.id,
    status: row.status,
    patientId: row.patient_id,
    patientName: row.patient_name ?? null,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name ?? null,
    slotId: row.slot_id,
    scheduledAt: iso(row.scheduled_at)!,
    endsAt: iso(row.ends_at)!,
    feePaise: row.fee_paise,
    reason: cipher ? cipher.decryptNullable(row.reason_enc, CONSULTATION_AAD.reason) : null,
    notes: cipher ? cipher.decryptNullable(row.notes_enc, CONSULTATION_AAD.notes) : null,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason,
    paymentStatus: row.payment_status ?? null,
    version: row.version,
  };
}
