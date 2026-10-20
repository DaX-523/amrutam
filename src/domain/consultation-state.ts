import type { ConsultationStatus } from '../db/types.js';
import { Errors } from './errors.js';

/**
 * Consultation lifecycle. Every status change goes through `assertTransition`, and the
 * UPDATE is guarded by `WHERE status = <from> AND version = <v>` (optimistic locking).
 *
 *   pending_payment ──pay──▶ confirmed ──start──▶ in_progress ──complete──▶ completed
 *         │                     │  │
 *         └──cancel/expire──▶ cancelled ◀──cancel┘  └──no-show──▶ no_show
 */
export const TRANSITIONS: Record<ConsultationStatus, readonly ConsultationStatus[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: ConsultationStatus, to: ConsultationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ConsultationStatus, to: ConsultationStatus): void {
  if (!canTransition(from, to)) {
    throw Errors.conflict('INVALID_STATE_TRANSITION', `Cannot move consultation from ${from} to ${to}`, {
      from,
      to,
      allowed: TRANSITIONS[from],
    });
  }
}

export const TERMINAL_STATUSES: ReadonlySet<ConsultationStatus> = new Set(['completed', 'cancelled', 'no_show']);

/** Doctors may open the consultation room shortly before the scheduled time. */
export const EARLY_START_MINUTES = 10;
/** A patient is a no-show only after this grace period. */
export const NO_SHOW_GRACE_MINUTES = 15;
