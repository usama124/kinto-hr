import { describe, expect, it } from 'vitest';
import {
  PLANS,
  assertCanActivate,
  assertDraftActivation,
  hasPermission,
  canFinalizePayroll,
} from './index';
describe('capacity and permissions', () => {
  it.each(Object.entries(PLANS))(
    '%s permits its last seat but rejects the next',
    (_name, plan) => {
      expect(() =>
        assertCanActivate(plan.employeeLimit - 1, plan.employeeLimit),
      ).not.toThrow();
      expect(() =>
        assertCanActivate(plan.employeeLimit, plan.employeeLimit),
      ).toThrow('CAPACITY_REACHED');
    },
  );
  it.each([
    [-1, 5],
    [1.5, 5],
    [1, -1],
    [1, 1.5],
    [NaN, 5],
    [1, Infinity],
  ])('rejects corrupt capacity %s/%s', (count, limit) => {
    expect(() => assertCanActivate(count, limit)).toThrow('INVALID_STATE');
  });
  it('allows no activation when disabled or over capacity', () => {
    expect(() => assertCanActivate(0, 0)).toThrow('CAPACITY_REACHED');
    expect(() => assertCanActivate(6, 5)).toThrow('CAPACITY_REACHED');
  });
  it('does not grant owners, HR or operators implicit payroll privileges', () => {
    expect(hasPermission(['owner'], 'employees.write')).toBe(true);
    expect(hasPermission(['hr_admin'], 'employees.read')).toBe(true);
    expect(
      hasPermission(
        ['owner', 'hr_admin', 'platform_operator'],
        'payroll.finalize',
      ),
    ).toBe(false);
    expect(hasPermission(['employee'], 'employees.read')).toBe(false);
    expect(hasPermission([], 'billing.manage')).toBe(false);
  });
  it('requires a different eligible approver even with combined roles', () => {
    expect(
      canFinalizePayroll(['payroll_approver'], 'reviewer', 'preparer'),
    ).toBe(true);
    expect(
      canFinalizePayroll(
        ['payroll_preparer', 'payroll_approver'],
        'same',
        'same',
      ),
    ).toBe(false);
    expect(canFinalizePayroll(['owner'], 'reviewer', 'preparer')).toBe(false);
    expect(canFinalizePayroll(['payroll_approver'], '', 'preparer')).toBe(
      false,
    );
    expect(canFinalizePayroll(['payroll_approver'], 'reviewer', '')).toBe(
      false,
    );
  });
  it('checks optimistic version and draft state', () => {
    expect(() => assertDraftActivation('draft', 1, 1)).not.toThrow();
    expect(() => assertDraftActivation('draft', 2, 1)).toThrow('STALE_VERSION');
    expect(() => assertDraftActivation('active', 2, 2)).toThrow(
      'INVALID_STATE',
    );
  });
});
