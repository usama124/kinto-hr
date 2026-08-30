export const PLANS = {
  free: { employeeLimit: 5 },
  starter: { employeeLimit: 20 },
  growth: { employeeLimit: 50 },
  business: { employeeLimit: 100 },
  scale: { employeeLimit: 250 },
} as const;
export type Plan = keyof typeof PLANS;
export type Role =
  | 'owner'
  | 'hr_admin'
  | 'payroll_preparer'
  | 'payroll_approver'
  | 'employee'
  | 'platform_operator';
export type Permission =
  | 'employees.read'
  | 'employees.write'
  | 'payroll.prepare'
  | 'payroll.finalize'
  | 'billing.manage';
const permissions: Record<Role, readonly Permission[]> = {
  owner: ['employees.read', 'employees.write', 'billing.manage'],
  hr_admin: ['employees.read', 'employees.write'],
  payroll_preparer: ['payroll.prepare'],
  payroll_approver: ['payroll.finalize'],
  employee: [],
  platform_operator: [],
};
export function hasPermission(
  roles: readonly Role[],
  permission: Permission,
): boolean {
  return roles.some((role) => permissions[role]?.includes(permission));
}
export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'CAPACITY_REACHED'
      | 'INVALID_STATE'
      | 'STALE_VERSION'
      | 'TENANT_UNAVAILABLE'
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'CONFLICT',
  ) {
    super(code);
    this.name = 'DomainError';
  }
}
export function assertCanActivate(activeCount: number, limit: number): void {
  if (
    !Number.isSafeInteger(activeCount) ||
    activeCount < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 0
  )
    throw new DomainError('INVALID_STATE');
  if (activeCount >= limit) throw new DomainError('CAPACITY_REACHED');
}
// A business invariant, not an implemented or enabled payroll endpoint.
export function canFinalizePayroll(
  roles: readonly Role[],
  actorId: string,
  preparerId: string,
): boolean {
  return (
    actorId.length > 0 &&
    preparerId.length > 0 &&
    actorId !== preparerId &&
    hasPermission(roles, 'payroll.finalize')
  );
}
export function assertDraftActivation(
  status: string,
  actualVersion: number,
  expectedVersion: number,
): void {
  if (actualVersion !== expectedVersion) throw new DomainError('STALE_VERSION');
  if (status !== 'draft') throw new DomainError('INVALID_STATE');
}
