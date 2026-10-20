import type { UserRole } from '../db/types.js';

/**
 * Role -> permission matrix (coarse RBAC). Resource ownership ("is this MY consultation?")
 * is enforced in services on top of this, so a permission never implies access to all rows.
 */
export const PERMISSIONS = [
  'profile:manage_own',
  'mfa:manage_own',
  'doctors:read',
  'doctor_profile:manage_own',
  'slots:manage_own',
  'bookings:create',
  'consultations:read_own',
  'consultations:cancel_own',
  'consultations:conduct',
  'prescriptions:write',
  'prescriptions:read_own',
  'data:export_own',
  'admin:doctors',
  'admin:users',
  'admin:audit',
  'admin:analytics',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const common: Permission[] = ['profile:manage_own', 'mfa:manage_own', 'doctors:read', 'data:export_own'];

export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  patient: new Set<Permission>([
    ...common,
    'bookings:create',
    'consultations:read_own',
    'consultations:cancel_own',
    'prescriptions:read_own',
  ]),
  doctor: new Set<Permission>([
    ...common,
    'doctor_profile:manage_own',
    'slots:manage_own',
    'consultations:read_own',
    'consultations:cancel_own',
    'consultations:conduct',
    'prescriptions:write',
    'prescriptions:read_own',
  ]),
  // Admins operate the platform but get no blanket PHI access (least privilege).
  admin: new Set<Permission>([...common, 'admin:doctors', 'admin:users', 'admin:audit', 'admin:analytics']),
};

/** Roles that must complete MFA before using anything other than MFA enrolment. */
export const MFA_REQUIRED_ROLES: ReadonlySet<UserRole> = new Set(['doctor', 'admin']);

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
