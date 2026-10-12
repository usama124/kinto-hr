import { describe, expect, it } from 'vitest';
import {
  previewAttendanceTiming,
  previewAttendanceNormalization,
  previewAttendanceAssociation,
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

describe('synthetic attendance normalization and schedule association', () => {
  const tenantId = '10000000-0000-4000-8000-000000000001',
    deviceId = '10000000-0000-4000-8000-000000000002';
  const event = {
    connectorEventId: '10000000-0000-4000-8000-000000000003',
    sourceUserId: '0007',
    sourceEventId: 'source:001',
    sourceLocalTimestamp: '2026-10-12T22:00:00',
    direction: 'in',
    workCode: '0001',
  };
  const context = {
    tenantId,
    deviceId,
    timeZone: 'Asia/Karachi',
    receivedAt: '2026-10-13T04:00:00Z',
    sourceIdentity: 'verified',
    clock: {
      status: 'verified',
      observedDriftMilliseconds: 0,
      maximumAbsoluteDriftMilliseconds: 1000,
      maximumFutureLeadMilliseconds: 1000,
    },
  };
  const settings = {
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
    weeklyRestDays: [7],
  };
  const policy = {
    id: '10000000-0000-4000-8000-000000000004',
    version: 1,
    basedOnVersion: 0,
    status: 'published',
    effectiveFrom: '2026-10-12',
    settings,
    reason: 'Reviewed synthetic schedule',
    createdAt: '2026-10-11T00:00:00Z',
    publishedAt: '2026-10-11T01:00:00Z',
  };
  const schedule = { tenantId, deviceId, workDate: '2026-10-12', policy };
  const normalize = (timestamp = event.sourceLocalTimestamp) =>
    previewAttendanceNormalization(
      { ...event, sourceLocalTimestamp: timestamp },
      context,
    );
  it('preserves source values and server receipt time separately from UTC without changing input', () => {
    const source = { ...event },
      original = structuredClone(source);
    const result = previewAttendanceNormalization(source, {
      ...context,
      receivedAt: '2026-10-13T09:00:00+05:00',
    });
    expect(result).toMatchObject({
      status: 'candidate',
      occurredAt: '2026-10-12T17:00:00.000Z',
      receivedAt: '2026-10-13T04:00:00.000Z',
      source: original,
      reviewCodes: [],
      attendanceProcessingAvailable: false,
      payrollEffectsAvailable: false,
    });
    result.source.sourceUserId = 'changed';
    expect(source).toEqual(original);
  });
  it.each([
    ['.1', '.100Z'],
    ['.12', '.120Z'],
    ['.123', '.123Z'],
  ])('retains fractional second precision %s', (fraction, expected) => {
    expect(normalize('2026-10-12T22:00:00' + fraction).occurredAt).toBe(
      '2026-10-12T17:00:00' + expected,
    );
  });
  it('keeps missing directions unknown and preserves out-of-order/offline timestamps', () => {
    const source = {
      connectorEventId: event.connectorEventId,
      sourceUserId: '0007',
      sourceLocalTimestamp: '2026-10-01T09:00:00',
    };
    const result = previewAttendanceNormalization(source, context);
    expect(result.status).toBe('candidate');
    expect(result.source).toEqual(source);
    expect(result.occurredAt).toBe('2026-10-01T04:00:00.000Z');
    expect(result.source.direction).toBeUndefined();
    expect(normalize()).toEqual(normalize());
  });
  it('does not promote unverified source identity or clock and keeps suspect evidence unresolved', () => {
    const result = previewAttendanceNormalization(event, {
      ...context,
      sourceIdentity: 'unverified',
      clock: { status: 'unverified' },
    });
    expect(result).toMatchObject({
      status: 'needs_review',
      occurredAt: null,
      reviewCodes: ['source_identity_unverified', 'clock_unverified'],
    });
    expect(previewAttendanceAssociation(result, [schedule])).toMatchObject({
      status: 'needs_review',
      code: 'normalization_unverified',
      attendanceProcessingAvailable: false,
      payrollEffectsAvailable: false,
    });
  });
  it.each([-1001, -1000, 0, 1000, 1001])(
    'tests absolute drift boundary %s without adjusting the clock',
    (drift) => {
      const result = previewAttendanceNormalization(event, {
        ...context,
        clock: { ...context.clock, observedDriftMilliseconds: drift },
      });
      expect(result.status).toBe(
        Math.abs(drift) > 1000 ? 'needs_review' : 'candidate',
      );
      expect(result.occurredAt).toBe(
        Math.abs(drift) > 1000 ? null : '2026-10-12T17:00:00.000Z',
      );
      expect(result.source.sourceLocalTimestamp).toBe(
        event.sourceLocalTimestamp,
      );
    },
  );
  it.each([
    ['2026-10-13T09:00:01', 'candidate'],
    ['2026-10-13T09:00:01.001', 'needs_review'],
  ])('tests future receipt boundary %s', (timestamp, expected) => {
    const result = normalize(timestamp);
    expect(result.status).toBe(expected);
    if (expected === 'needs_review')
      expect(result.reviewCodes).toEqual(['event_in_future']);
  });
  it('refuses a historical offset not matching the fixed-offset IANA candidate', () => {
    expect(normalize('2009-07-01T09:00:00')).toMatchObject({
      status: 'needs_review',
      occurredAt: null,
      reviewCodes: ['unsupported_timezone_offset'],
    });
  });
  it('refuses dates near a historical fallback rather than guess a repeated wall time', () => {
    expect(normalize('2009-10-31T23:30:00')).toMatchObject({
      status: 'needs_review',
      occurredAt: null,
      reviewCodes: ['unsupported_timezone_offset'],
    });
  });
  it.each([
    '2026-02-30T09:00:00',
    '2026-10-12T24:00:00',
    '2026-10-12T22:00:60',
    '2026-10-12T22:00:00Z',
    '2026-10-12T22:00:00.1234',
  ])('rejects invalid original timestamps %s', (timestamp) => {
    expect(() => normalize(timestamp)).toThrow();
  });
  it('rejects corrupt scope and clock configuration instead of guessing limits', () => {
    for (const input of [
      null,
      {},
      { ...context, timeZone: 'UTC' },
      { ...context, deviceId: 'bad' },
      { ...context, receivedAt: 'local' },
      {
        ...context,
        clock: { ...context.clock, maximumFutureLeadMilliseconds: -1 },
      },
      {
        ...context,
        clock: { ...context.clock, observedDriftMilliseconds: Infinity },
      },
      {
        ...context,
        clock: { ...context.clock, maximumAbsoluteDriftMilliseconds: 86400001 },
      },
      {
        ...context,
        clock: { ...context.clock, maximumFutureLeadMilliseconds: '1000' },
      },
    ])
      expect(() => previewAttendanceNormalization(event, input)).toThrow();
  });
  it('anchors overnight punches to the start date with immutable version references', () => {
    const normalized = normalize('2026-10-13T06:00:00'),
      candidates = [schedule, { ...schedule, workDate: '2026-10-13' }];
    const original = structuredClone(candidates);
    const result = previewAttendanceAssociation(normalized, candidates);
    expect(result).toMatchObject({
      status: 'schedule_candidate',
      workDate: '2026-10-12',
      policyId: policy.id,
      policyVersion: 1,
      policyEffectiveFrom: policy.effectiveFrom,
      occurredAt: '2026-10-13T01:00:00.000Z',
      dayAnchor: 'scheduled_check_in_local_date',
      associationWindow: {
        from: '2026-10-12T16:30:00.000Z',
        until: '2026-10-13T02:00:00.000Z',
        endExclusive: true,
      },
    });
    expect(candidates).toEqual(original);
    const changed = {
      ...schedule,
      policy: { ...policy, id: deviceId, version: 2, basedOnVersion: 1 },
    };
    expect(previewAttendanceAssociation(normalized, [changed])).toMatchObject({
      policyVersion: 2,
      policyId: deviceId,
    });
    expect(result).toMatchObject({ policyVersion: 1, policyId: policy.id });
  });
  it.each([
    ['2026-10-12T21:29:59.999', 'outside_window'],
    ['2026-10-12T21:30:00', 'schedule_candidate'],
    ['2026-10-13T06:59:59.999', 'schedule_candidate'],
    ['2026-10-13T07:00:00', 'outside_window'],
  ])('uses half-open association boundary %s', (timestamp, status) => {
    expect(
      previewAttendanceAssociation(normalize(timestamp), [schedule]).status,
    ).toBe(status);
  });
  it('supports negative previous-day offsets and rejects ambiguous transition windows', () => {
    const early = {
      ...schedule,
      workDate: '2026-10-13',
      policy: {
        ...policy,
        settings: {
          ...settings,
          checkIn: '00:15',
          checkOut: '08:15',
          checkOutNextDay: false,
        },
      },
    };
    expect(
      previewAttendanceAssociation(normalize('2026-10-12T23:45:00'), [early]),
    ).toMatchObject({ status: 'schedule_candidate', workDate: '2026-10-13' });
    expect(
      previewAttendanceAssociation(normalize('2026-10-13T00:00:00'), [
        schedule,
        early,
      ]),
    ).toMatchObject({ status: 'needs_review', code: 'ambiguous_schedule' });
    const historical = {
      ...schedule,
      workDate: '2009-07-01',
      policy: { ...policy, effectiveFrom: '2009-01-01' },
    };
    expect(
      previewAttendanceAssociation(normalize(), [historical]),
    ).toMatchObject({
      status: 'needs_review',
      code: 'unsupported_timezone_offset',
    });
  });
  it('rejects cross-company/device inputs, duplicate dates, draft/future policies and altered UTC', () => {
    for (const candidates of [
      [{ ...schedule, tenantId: deviceId }],
      [{ ...schedule, deviceId: tenantId }],
      [schedule, schedule],
      [
        {
          ...schedule,
          policy: { ...policy, status: 'draft', publishedAt: null },
        },
      ],
      [{ ...schedule, policy: { ...policy, effectiveFrom: '2026-10-13' } }],
      [],
      [schedule, schedule, schedule, schedule],
    ])
      expect(() =>
        previewAttendanceAssociation(normalize(), candidates),
      ).toThrow();
    expect(() =>
      previewAttendanceAssociation(
        { ...normalize(), occurredAt: '2026-10-12T18:00:00Z' },
        [schedule],
      ),
    ).toThrow('INVALID_ATTENDANCE_INSTANT');
    expect(() =>
      previewAttendanceAssociation(
        { ...normalize(), attendanceProcessingAvailable: true },
        [schedule],
      ),
    ).toThrow();
  });
  it('checks day/month/year and leap-day rollover independently of process timezone', () => {
    for (const [source, utc] of [
      ['2026-01-01T00:15:00', '2025-12-31T19:15:00.000Z'],
      ['2024-03-01T00:00:00', '2024-02-29T19:00:00.000Z'],
      ['2024-02-29T09:00:00', '2024-02-29T04:00:00.000Z'],
    ])
      expect(normalize(source).occurredAt).toBe(utc);
  });
});
