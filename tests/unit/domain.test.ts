import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, TRANSITIONS } from '../../src/domain/consultation-state.js';
import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS } from '../../src/domain/rbac-policy.js';
import { AppError } from '../../src/domain/errors.js';

describe('consultation state machine', () => {
  it('allows the happy path and cancellation only before the visit starts', () => {
    expect(canTransition('pending_payment', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
  });

  it('has no exits from terminal states', () => {
    for (const s of ['completed', 'cancelled', 'no_show'] as const) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('throws a 409 with the allowed transitions', () => {
    try {
      assertTransition('completed', 'in_progress');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(409);
      expect((e as AppError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });
});

describe('RBAC policy', () => {
  it('gives admins platform permissions but no clinical (PHI) access', () => {
    expect(hasPermission('admin', 'admin:audit')).toBe(true);
    expect(hasPermission('admin', 'prescriptions:read_own')).toBe(false);
    expect(hasPermission('admin', 'consultations:read_own')).toBe(false);
  });

  it('separates patient and doctor capabilities', () => {
    expect(hasPermission('patient', 'bookings:create')).toBe(true);
    expect(hasPermission('patient', 'prescriptions:write')).toBe(false);
    expect(hasPermission('doctor', 'prescriptions:write')).toBe(true);
    expect(hasPermission('doctor', 'bookings:create')).toBe(false);
  });

  it('only references declared permissions', () => {
    for (const set of Object.values(ROLE_PERMISSIONS)) for (const p of set) expect(PERMISSIONS).toContain(p);
  });
});
