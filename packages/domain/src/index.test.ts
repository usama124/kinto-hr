import { describe, expect, it } from 'vitest';
import {
  previewAttendanceTiming,
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
    expect(hasPermission(['hr_admin'], 'employees.private.write')).toBe(true);
    expect(hasPermission(['owner'], 'employees.checklists.write')).toBe(true);
    expect(hasPermission(['hr_admin'], 'employees.checklists.read')).toBe(true);
    expect(hasPermission(['owner'], 'employees.imports.write')).toBe(true);
    expect(hasPermission(['hr_admin'], 'employees.imports.read')).toBe(true);
    expect(hasPermission(['payroll_preparer'], 'employees.imports.read')).toBe(
      false,
    );
    expect(
      hasPermission(['payroll_preparer'], 'employees.checklists.read'),
    ).toBe(false);
    expect(hasPermission(['employee'], 'employees.checklists.write')).toBe(
      false,
    );
    expect(hasPermission(['payroll_preparer'], 'employees.private.read')).toBe(
      false,
    );
    expect(
      hasPermission(['payroll_preparer'], 'payroll.compensation.write'),
    ).toBe(true);
    expect(
      hasPermission(['payroll_approver'], 'payroll.compensation.read'),
    ).toBe(true);
    expect(
      hasPermission(['payroll_approver'], 'payroll.compensation.write'),
    ).toBe(false);
    expect(hasPermission(['owner'], 'payroll.compensation.read')).toBe(false);
    expect(hasPermission(['payroll_preparer'], 'payroll.bank.read')).toBe(true);
    expect(hasPermission(['payroll_preparer'], 'payroll.bank.write')).toBe(
      true,
    );
    expect(hasPermission(['payroll_approver'], 'payroll.bank.read')).toBe(true);
    expect(hasPermission(['payroll_approver'], 'payroll.bank.write')).toBe(
      false,
    );
    expect(
      hasPermission(
        ['owner', 'hr_admin', 'employee', 'platform_operator'],
        'payroll.bank.read',
      ),
    ).toBe(false);
    expect(
      hasPermission(['owner', 'payroll_preparer'], 'payroll.bank.write'),
    ).toBe(true);

    expect(
      hasPermission(
        ['owner', 'hr_admin', 'platform_operator'],
        'payroll.finalize',
      ),
    ).toBe(false);
    expect(hasPermission(['employee'], 'employees.read')).toBe(false);
    expect(hasPermission([], 'billing.manage')).toBe(false);
    expect(hasPermission(['owner'], 'organization.manage')).toBe(true);
    expect(hasPermission(['owner'], 'company_policies.manage')).toBe(true);
    expect(hasPermission(['hr_admin'], 'organization.read')).toBe(true);
    expect(hasPermission(['hr_admin'], 'company_policies.read')).toBe(true);
    expect(hasPermission(['hr_admin'], 'organization.manage')).toBe(false);
    expect(hasPermission(['employee'], 'company_policies.read')).toBe(false);
    expect(hasPermission(['owner'], 'entitlements.read')).toBe(true);
    expect(hasPermission(['hr_admin'], 'entitlements.read')).toBe(true);
    expect(hasPermission(['employee'], 'entitlements.read')).toBe(false);
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

it('limits device inventory management to owners and reading to owners or HR', () => {
  expect(hasPermission(['owner'], 'devices.read')).toBe(true);
  expect(hasPermission(['owner'], 'devices.manage')).toBe(true);
  expect(hasPermission(['hr_admin'], 'devices.read')).toBe(true);
  expect(hasPermission(['hr_admin'], 'devices.manage')).toBe(false);
  for (const role of [
    'employee',
    'payroll_preparer',
    'payroll_approver',
    'platform_operator',
  ] as const) {
    expect(hasPermission([role], 'devices.read')).toBe(false);
    expect(hasPermission([role], 'devices.manage')).toBe(false);
  }
});

const policy = {
  scope: 'company',
  timeZone: 'Asia/Karachi',
  checkIn: '22:00',
  checkOut: '06:00',
  checkOutNextDay: true,
  breakMode: 'fixed_duration',
  unpaidBreakMinutes: 30,
  fullDayTargetMinutes: 450,
  halfDayTargetMinutes: 225,
  minimumFullDayMinutes: 420,
  minimumHalfDayMinutes: 180,
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  associationBeforeMinutes: 30,
  associationAfterMinutes: 60,
  weeklyRestDays: [7, 6],
};
describe('pure company timing policy preview', () => {
  it('anchors overnight windows to check-in date and preserves targets separately from minimums', () => {
    const original = structuredClone(policy);
    const result = previewAttendanceTiming(policy);
    expect(result).toMatchObject({
      dayAnchor: 'scheduled_check_in_local_date',
      scheduledMinutes: 480,
      netScheduledMinutes: 450,
      associationWindow: {
        fromLocalMinute: 1290,
        untilLocalMinute: 1860,
        endExclusive: true,
      },
      settings: {
        minimumFullDayMinutes: 420,
        minimumHalfDayMinutes: 180,
        fullDayTargetMinutes: 450,
        halfDayTargetMinutes: 225,
        weeklyRestDays: [6, 7],
      },
      attendanceProcessingAvailable: false,
      payrollEffectsAvailable: false,
    });
    expect(policy).toEqual(original);
    result.settings.weeklyRestDays.push(1);
    expect(policy.weeklyRestDays).toEqual([7, 6]);
  });
  it('keeps grace out of actual net minutes and permits negative previous-day offsets', () => {
    const result = previewAttendanceTiming({
      ...policy,
      checkIn: '00:15',
      checkOut: '08:15',
      checkOutNextDay: false,
    });
    expect(result.associationWindow.fromLocalMinute).toBe(-15);
    expect(result.netScheduledMinutes).toBe(450);
    expect(
      previewAttendanceTiming({
        ...policy,
        lateGraceMinutes: 450,
        earlyGraceMinutes: 450,
      }).netScheduledMinutes,
    ).toBe(450);
  });
  it('validates unknown inputs before arithmetic instead of accepting typed corrupt objects', () => {
    for (const input of [
      null,
      {},
      { ...policy, checkIn: 'bad' },
      { ...policy, checkOutNextDay: false },
      { ...policy, minimumHalfDayMinutes: '180' },
      { ...policy, tenantId: 'caller-supplied' },
    ])
      expect(() => previewAttendanceTiming(input)).toThrow();
  });
  it('is deterministic across local start hours and preserves integer net/window bounds', () => {
    for (let start = 0; start < 24; start++) {
      const end = (start + 8) % 24;
      const input = {
        ...policy,
        checkIn: String(start).padStart(2, '0') + ':00',
        checkOut: String(end).padStart(2, '0') + ':00',
        checkOutNextDay: end < start,
      };
      const result = previewAttendanceTiming(input);
      expect(result).toEqual(previewAttendanceTiming(input));
      expect(result.scheduledMinutes).toBe(480);
      expect(result.netScheduledMinutes).toBe(450);
      expect(
        result.associationWindow.untilLocalMinute -
          result.associationWindow.fromLocalMinute,
      ).toBe(570);
    }
  });
});
