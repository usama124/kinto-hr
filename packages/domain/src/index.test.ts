import { describe, expect, it } from 'vitest';
import {
  leavePolicySettingsSchema,
  leavePolicyDraftSchema,
  leaveQuotaPreviewSchema,
  leaveLifecyclePreviewSchema,
  leaveLifecycleInputSchema,
  attendanceDayPreviewSchema,
  attendanceLeaveCompositionPreviewSchema,
} from '@kinto/contracts';
import {
  previewLeaveQuota,
  previewLeaveDecision,
  previewAttendanceTiming,
  previewAttendanceDay,
  previewAttendanceLeaveComposition,
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

describe('standard workday qualification preview', () => {
  const tenantId = '20000000-0000-4000-8000-000000000001',
    deviceId = '20000000-0000-4000-8000-000000000002',
    employeeId = '20000000-0000-4000-8000-000000000003';
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
    id: '20000000-0000-4000-8000-000000000004',
    version: 1,
    basedOnVersion: 0,
    status: 'published',
    effectiveFrom: '2026-10-12',
    settings,
    reason: 'Reviewed synthetic day policy',
    createdAt: '2026-10-11T00:00:00Z',
    publishedAt: '2026-10-11T01:00:00Z',
  };
  const mapping = {
    id: '20000000-0000-4000-8000-000000000005',
    deviceId,
    employeeId,
    sourceUserId: '0007',
    version: 1,
    effectiveFrom: '2026-10-01T00:00:00Z',
    effectiveUntil: null as string | null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  const context = {
    tenantId,
    deviceId,
    timeZone: 'Asia/Karachi',
    receivedAt: '2026-10-14T12:00:00Z',
    sourceIdentity: 'verified',
    clock: {
      status: 'verified',
      observedDriftMilliseconds: 0,
      maximumAbsoluteDriftMilliseconds: 1000,
      maximumFutureLeadMilliseconds: 1000,
    },
  };
  function punch(
    timestamp: string,
    direction: 'in' | 'out' | undefined,
    n = 1,
  ) {
    return {
      normalized: previewAttendanceNormalization(
        {
          connectorEventId: `20000000-0000-4000-8000-${String(10 + n).padStart(12, '0')}`,
          sourceUserId: '0007',
          sourceEventId: 'test:' + n,
          sourceLocalTimestamp: timestamp,
          ...(direction ? { direction } : {}),
        },
        context,
      ),
      mapping: { ...mapping } as typeof mapping | null,
    };
  }
  const fixture = () => ({
    tenantId,
    deviceId,
    employeeId,
    workDate: '2026-10-12',
    schedules: [
      {
        tenantId,
        deviceId,
        workDate: '2026-10-12',
        policy: structuredClone(policy),
      },
    ],
    coverageMapping: { ...mapping } as typeof mapping | null,
    employment: 'employed',
    calendar: 'working_day',
    leave: 'none',
    evidence: 'complete_closed',
    periodState: 'open',
    punchRule: 'verified_in_out',
    punches: [
      punch('2026-10-12T22:00:00', 'in', 1),
      punch('2026-10-13T06:00:00', 'out', 2),
    ],
  });
  it('calculates an overnight full day with one fixed break, exact references and disabled pay effects', () => {
    const day = fixture(),
      original = structuredClone(day);
    const result = previewAttendanceDay(day);
    expect(result).toMatchObject({
      status: 'qualified_candidate',
      qualification: 'full_day',
      uncoveredAbsenceUnits: 0,
      workedMinutes: 450,
      eligibleWorkedMinutes: 450,
      grossWorkedMilliseconds: 480 * 60000,
      breakDeductedMilliseconds: 30 * 60000,
      workedMilliseconds: 450 * 60000,
      eligibleWorkedMilliseconds: 450 * 60000,
      scheduledMinutes: 480,
      netScheduledMinutes: 450,
      policyId: policy.id,
      policyVersion: 1,
      workDate: '2026-10-12',
      calculationVersion: 1,
      firstPunchAt: '2026-10-12T17:00:00.000Z',
      lastPunchAt: '2026-10-13T01:00:00.000Z',
      uniquePunchCount: 2,
      isLate: false,
      isEarly: false,
      overtimeCandidateMilliseconds: 0,
      overtimePayable: false,
      attendanceProcessingAvailable: false,
      payrollEffectsAvailable: false,
    });
    if (result.status !== 'qualified_candidate')
      throw new Error('Unexpected review');
    expect(result.punchReferences).toEqual(
      day.punches.map((v) => ({
        connectorEventId: v.normalized.source.connectorEventId,
        mappingId: mapping.id,
        mappingVersion: 1,
      })),
    );
    result.punchReferences[0].mappingVersion = 99;
    expect(day).toEqual(original);
  });
  it.each([
    [180 * 60000 - 1, 'insufficient', 1],
    [180 * 60000, 'half_day', 0.5],
    [180 * 60000 + 1, 'half_day', 0.5],
    [420 * 60000 - 1, 'half_day', 0.5],
    [420 * 60000, 'full_day', 0],
    [420 * 60000 + 1, 'full_day', 0],
  ])(
    'qualifies exact eligible millisecond threshold %s',
    (eligible, qualification, units) => {
      const day = fixture();
      const end = new Date(
        Date.parse('2026-10-12T22:00:00Z') + eligible + 30 * 60000,
      )
        .toISOString()
        .slice(0, -1);
      day.punches[1] = punch(end, 'out', 2);
      expect(previewAttendanceDay(day)).toMatchObject({
        status: 'qualified_candidate',
        qualification,
        uncoveredAbsenceUnits: units,
        eligibleWorkedMilliseconds: eligible,
        workedMilliseconds: eligible,
      });
    },
  );
  it('does not confuse target minutes with minimums or let grace invent eligible work', () => {
    const day = fixture();
    day.punches[1] = punch('2026-10-13T05:30:00', 'out', 2);
    day.schedules[0].policy.settings.earlyGraceMinutes = 60;
    expect(previewAttendanceDay(day)).toMatchObject({
      qualification: 'full_day',
      workedMinutes: 420,
      eligibleWorkedMinutes: 420,
      netScheduledMinutes: 450,
      isEarly: false,
      earlyMilliseconds: 30 * 60000,
    });
  });
  it.each([
    [0, 480, 0],
    [30, 450, 30],
  ])(
    'subtracts fixed break %s once',
    (breakMinutes, workedMinutes, deducted) => {
      const day = fixture();
      day.schedules[0].policy.settings.unpaidBreakMinutes = breakMinutes;
      expect(previewAttendanceDay(day)).toMatchObject({
        workedMinutes,
        breakDeductedMilliseconds: deducted * 60000,
      });
    },
  );
  it('clamps a short interval at zero without erasing the gross duration', () => {
    const day = fixture();
    day.punches[1] = punch('2026-10-12T22:10:00', 'out', 2);
    expect(previewAttendanceDay(day)).toMatchObject({
      qualification: 'insufficient',
      grossWorkedMilliseconds: 10 * 60000,
      breakDeductedMilliseconds: 10 * 60000,
      workedMinutes: 0,
      eligibleWorkedMinutes: 0,
    });
  });
  it('preserves actual work outside the schedule but never uses candidate overtime to fill thresholds', () => {
    const day = fixture();
    day.punches = [
      punch('2026-10-12T21:45:00', 'in', 1),
      punch('2026-10-13T06:30:00', 'out', 2),
    ];
    expect(previewAttendanceDay(day)).toMatchObject({
      workedMinutes: 495,
      eligibleWorkedMinutes: 450,
      overtimeCandidateMilliseconds: 45 * 60000,
      overtimePayable: false,
    });
    day.punches = [
      punch('2026-10-13T05:59:00', 'in', 1),
      punch('2026-10-13T06:59:00', 'out', 2),
    ];
    expect(previewAttendanceDay(day)).toMatchObject({
      qualification: 'insufficient',
      workedMinutes: 30,
      eligibleWorkedMinutes: 0,
      overtimeCandidateMilliseconds: 30 * 60000,
    });
  });
  it.each([0, 1])(
    'uses inclusive grace boundaries without rounding %s',
    (extra) => {
      const day = fixture();
      const suffix = extra ? '.001' : '';
      day.punches = [
        punch('2026-10-12T22:10:00' + suffix, 'in', 1),
        punch('2026-10-13T05:50:00', 'out', 2),
      ];
      expect(previewAttendanceDay(day)).toMatchObject({
        lateMilliseconds: 10 * 60000 + extra,
        earlyMilliseconds: 10 * 60000,
        isLate: !!extra,
        isEarly: false,
        eligibleWorkedMilliseconds: 430 * 60000 - extra,
      });
    },
  );
  it('uses independent company thresholds and does not mutate an earlier policy result', () => {
    const day = fixture();
    day.punches[1] = punch('2026-10-13T05:30:00', 'out', 2);
    const original = previewAttendanceDay(day);
    day.schedules[0].policy.version = 2;
    day.schedules[0].policy.basedOnVersion = 1;
    day.schedules[0].policy.settings.minimumFullDayMinutes = 450;
    expect(previewAttendanceDay(day)).toMatchObject({
      qualification: 'half_day',
      policyVersion: 2,
    });
    expect(original).toMatchObject({
      qualification: 'full_day',
      policyVersion: 1,
    });
    day.tenantId = deviceId;
    day.schedules[0].tenantId = deviceId;
    for (const v of day.punches) v.normalized.tenantId = deviceId;
    expect(previewAttendanceDay(day)).toMatchObject({
      tenantId: deviceId,
      qualification: 'half_day',
    });
    day.periodState = 'locked';
    expect(previewAttendanceDay(day)).toMatchObject({
      status: 'needs_review',
      code: 'locked_period',
      workedMinutes: null,
      uncoveredAbsenceUnits: null,
    });
  });
  it('sorts out-of-order evidence and deduplicates exact transport retries regardless of receipt time', () => {
    const day = fixture(),
      original = previewAttendanceDay(day);
    const duplicate = structuredClone(day.punches[0]);
    duplicate.normalized.receivedAt = '2026-10-13T13:00:00Z';
    day.punches = [day.punches[1], duplicate, day.punches[0]];
    expect(previewAttendanceDay(day)).toEqual(original);
  });
  it('refuses conflicting transport and unproven vendor duplicate identities', () => {
    const day = fixture(),
      duplicate = structuredClone(day.punches[0]);
    duplicate.normalized.source.workCode = 'changed';
    day.punches.push(duplicate);
    expect(previewAttendanceDay(day)).toMatchObject({
      status: 'needs_review',
      code: 'conflicting_duplicate',
    });
    const other = fixture();
    other.punches[1].normalized.source.sourceEventId =
      other.punches[0].normalized.source.sourceEventId;
    expect(previewAttendanceDay(other)).toMatchObject({
      code: 'source_identity_conflict',
      uncoveredAbsenceUnits: null,
    });
  });
  it('requires complete closed evidence before a no-punch absence candidate and never deducts salary', () => {
    const day = fixture();
    day.punches = [];
    expect(previewAttendanceDay(day)).toMatchObject({
      status: 'qualified_candidate',
      qualification: 'no_punch_absence',
      uncoveredAbsenceUnits: 1,
      workedMinutes: 0,
      uniquePunchCount: 0,
      firstPunchAt: null,
      lastPunchAt: null,
      isLate: false,
      isEarly: false,
      payrollEffectsAvailable: false,
    });
    day.coverageMapping = null;
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_unresolved',
      uncoveredAbsenceUnits: null,
    });
    day.coverageMapping = {
      ...mapping,
      effectiveUntil: '2026-10-13T01:00:00Z',
    };
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_outside_interval',
      uncoveredAbsenceUnits: null,
    });
    day.coverageMapping = { ...mapping, effectiveFrom: '2026-10-12T18:00:00Z' };
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_outside_interval',
      uncoveredAbsenceUnits: null,
    });
    day.evidence = 'incomplete';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'incomplete_evidence',
      workedMinutes: null,
      uncoveredAbsenceUnits: null,
    });
  });
  it.each(['holiday', 'rest_day'])(
    'does not label %s as absence',
    (calendar) => {
      const day = fixture();
      day.calendar = calendar;
      day.punches = [];
      expect(previewAttendanceDay(day)).toMatchObject({
        status: calendar,
        workedMinutes: null,
        uncoveredAbsenceUnits: null,
      });
      day.punches = fixture().punches;
      expect(previewAttendanceDay(day)).toMatchObject({
        code: 'non_workday_punches',
      });
    },
  );
  it('handles non-employed and approved full-leave dates without guessed payable units', () => {
    const day = fixture();
    day.employment = 'not_employed';
    day.punches = [];
    day.schedules = [];
    expect(previewAttendanceDay(day)).toMatchObject({
      status: 'not_employed',
      policyId: null,
      uncoveredAbsenceUnits: null,
    });
    day.punches = fixture().punches;
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'non_workday_punches',
    });
    const leave = fixture();
    leave.leave = 'approved_full_day';
    leave.punches = [];
    expect(previewAttendanceDay(leave)).toMatchObject({
      status: 'leave',
      uncoveredAbsenceUnits: null,
    });
    leave.punches = fixture().punches;
    expect(previewAttendanceDay(leave)).toMatchObject({
      code: 'non_workday_punches',
    });
  });
  it('keeps partial/pending leave plus attendance unresolved rather than charging a half-day absence', () => {
    const day = fixture();
    day.leave = 'partial_or_pending';
    day.punches[1] = punch('2026-10-13T02:15:00', 'out', 2);
    expect(previewAttendanceDay(day)).toMatchObject({
      status: 'needs_review',
      code: 'leave_composition_required',
      uncoveredAbsenceUnits: null,
      workedMinutes: null,
    });
  });
  it('keeps unknown employment, calendar, schedule and conflicting weekly rest policy unresolved', () => {
    const day = fixture();
    day.employment = 'unknown';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'employment_unknown',
    });
    day.employment = 'employed';
    day.calendar = 'unknown';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'calendar_unknown',
    });
    day.calendar = 'working_day';
    day.schedules = [];
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'unknown_schedule',
    });
    day.schedules = fixture().schedules;
    day.schedules[0].policy.settings.weeklyRestDays = [1];
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'calendar_policy_conflict',
    });
  });
  it('refuses unsupported historical schedule offsets even on a zero-punch day', () => {
    const day = fixture();
    day.workDate = '2009-07-01';
    day.schedules[0].workDate = day.workDate;
    day.schedules[0].policy.effectiveFrom = '2009-01-01';
    day.punches = [];
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'association_unresolved',
      uncoveredAbsenceUnits: null,
    });
  });
  it('refuses single, tied, incomplete-direction and multiple-pair evidence', () => {
    const day = fixture();
    day.punches.pop();
    expect(previewAttendanceDay(day)).toMatchObject({ code: 'missing_punch' });
    day.punches = [
      punch('2026-10-12T22:00:00', 'in', 1),
      punch('2026-10-12T22:00:00', 'out', 2),
    ];
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'ambiguous_punches',
    });
    day.punches = [
      punch('2026-10-12T22:00:00', undefined, 1),
      punch('2026-10-13T06:00:00', undefined, 2),
    ];
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'ambiguous_punches',
    });
    day.punches = fixture().punches;
    day.punches[0].normalized.source.direction = 'out';
    day.punches[1].normalized.source.direction = 'in';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'ambiguous_punches',
    });
    day.punches = fixture().punches;
    day.punches.push(punch('2026-10-13T02:00:00', 'out', 3));
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'ambiguous_punches',
    });
  });
  it('requires explicit approved first/last mode for directionless punches', () => {
    const day = fixture();
    day.punchRule = 'approved_first_last';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'direction_rule_mismatch',
    });
    day.punches = [
      punch('2026-10-13T02:00:00', undefined, 3),
      punch('2026-10-13T06:00:00', undefined, 2),
      punch('2026-10-12T22:00:00', undefined, 1),
    ];
    expect(previewAttendanceDay(day)).toMatchObject({
      qualification: 'full_day',
      workedMinutes: 450,
      uniquePunchCount: 3,
    });
  });
  it('refuses unverified normalization, unresolved mapping, source mismatches and mapping interval ends', () => {
    const day = fixture();
    day.punches[0].normalized = previewAttendanceNormalization(
      day.punches[0].normalized.source,
      { ...context, sourceIdentity: 'unverified' },
    );
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'normalization_unverified',
    });
    day.punches = fixture().punches;
    day.punches[0].mapping = null;
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_unresolved',
    });
    day.punches = fixture().punches;
    day.punches[0].mapping!.sourceUserId = '7';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_source_mismatch',
    });
    day.punches = fixture().punches;
    day.punches[1].mapping!.effectiveUntil = '2026-10-13T01:00:00Z';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_outside_interval',
    });
    day.punches = fixture().punches;
    day.punches[0].mapping!.effectiveFrom = '2026-10-12T18:00:00Z';
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'mapping_outside_interval',
    });
  });
  it('does not silently discard outside-window, different-workdate or ambiguously associated punches', () => {
    const day = fixture();
    day.punches[0] = punch('2026-10-12T21:29:59.999', 'in', 1);
    expect(previewAttendanceDay(day)).toMatchObject({ code: 'outside_window' });
    day.punches = fixture().punches;
    day.schedules.push({
      ...structuredClone(day.schedules[0]),
      workDate: '2026-10-13',
    });
    day.punches[1] = punch('2026-10-13T22:00:00', 'out', 2);
    expect(previewAttendanceDay(day)).toMatchObject({ code: 'wrong_workdate' });
    day.punches = fixture().punches;
    day.schedules[1].policy.settings.checkIn = '00:15';
    day.schedules[1].policy.settings.checkOut = '08:15';
    day.schedules[1].policy.settings.checkOutNextDay = false;
    day.punches[1] = punch('2026-10-13T00:00:00', 'out', 2);
    expect(previewAttendanceDay(day)).toMatchObject({
      code: 'association_unresolved',
    });
  });
  it('rejects contradictory qualification responses rather than expose false absence or work totals', () => {
    const result = previewAttendanceDay(fixture());
    if (result.status !== 'qualified_candidate')
      throw new Error('Unexpected review');
    for (const corrupted of [
      { ...result, uncoveredAbsenceUnits: 1 },
      { ...result, policyId: null },
      { ...result, uniquePunchCount: 0 },
      { ...result, firstPunchAt: null },
      { ...result, lastPunchAt: result.firstPunchAt },
      { ...result, punchReferences: [] },
      {
        ...result,
        punchReferences: [result.punchReferences[0], result.punchReferences[0]],
      },
      { ...result, netScheduledMinutes: 481 },
      {
        ...result,
        breakDeductedMilliseconds: result.grossWorkedMilliseconds + 1,
      },
      { ...result, workedMilliseconds: result.workedMilliseconds - 1 },
      { ...result, eligibleWorkedMilliseconds: result.workedMilliseconds + 1 },
      {
        ...result,
        eligibleBreakDeductedMilliseconds: result.breakDeductedMilliseconds + 1,
      },
      { ...result, workedMinutes: 451 },
      { ...result, eligibleWorkedMinutes: 451 },
      { ...result, overtimeCandidateMilliseconds: 1 },
      {
        ...result,
        qualification: 'no_punch_absence',
        uncoveredAbsenceUnits: 1,
      },
    ])
      expect(attendanceDayPreviewSchema.safeParse(corrupted).success).toBe(
        false,
      );
    const day = fixture();
    day.punches = [];
    const absent = previewAttendanceDay(day);
    for (const corrupted of [
      { ...absent, isLate: true },
      { ...absent, isEarly: true },
      { ...absent, lateMilliseconds: 1 },
      { ...absent, earlyMilliseconds: 1 },
    ])
      expect(attendanceDayPreviewSchema.safeParse(corrupted).success).toBe(
        false,
      );
  });
  it('rejects corrupted settings, foreign scope, future/draft schedules and forged UTC instants', () => {
    for (const field of ['tenantId', 'deviceId', 'employeeId'] as const) {
      const day = fixture();
      day[field] = policy.id;
      expect(() => previewAttendanceDay(day)).toThrow(
        'ATTENDANCE_SCOPE_MISMATCH',
      );
    }
    const future = fixture();
    future.schedules[0].policy.effectiveFrom = '2026-10-13';
    expect(() => previewAttendanceDay(future)).toThrow(
      'INVALID_ATTENDANCE_SCHEDULE',
    );
    const duplicate = fixture();
    duplicate.schedules.push(structuredClone(duplicate.schedules[0]));
    expect(() => previewAttendanceDay(duplicate)).toThrow(
      'INVALID_ATTENDANCE_SCHEDULE',
    );
    const altered = fixture();
    altered.punches[0].normalized.occurredAt = '2026-10-12T18:00:00Z';
    expect(() => previewAttendanceDay(altered)).toThrow(
      'INVALID_ATTENDANCE_INSTANT',
    );
    for (const input of [
      null,
      {},
      { ...fixture(), evidence: 'guessed' },
      { ...fixture(), payrollEffectsAvailable: true },
      { ...fixture(), punches: Array(501).fill(fixture().punches[0]) },
      {
        ...fixture(),
        schedules: [
          {
            ...fixture().schedules[0],
            policy: { ...policy, status: 'draft', publishedAt: null },
          },
        ],
      },
      {
        ...fixture(),
        schedules: [
          {
            ...fixture().schedules[0],
            policy: {
              ...policy,
              settings: { ...settings, minimumFullDayMinutes: 500 },
            },
          },
        ],
      },
    ])
      expect(() => previewAttendanceDay(input)).toThrow();
  });

  function composition(workFirst = false, pay = 'paid') {
    const day = fixture();
    day.leave = 'partial_or_pending';
    day.punches = workFirst
      ? [
          punch('2026-10-12T22:00:00', 'in', 1),
          punch('2026-10-13T02:00:00', 'out', 2),
        ]
      : [
          punch('2026-10-13T02:00:00', 'in', 1),
          punch('2026-10-13T06:00:00', 'out', 2),
        ];
    const approval = {
      id: '20000000-0000-4000-8000-000000000006',
      version: 1,
      tenantId,
      employeeId,
      workDate: day.workDate,
      status: 'approved',
      pay,
    };
    const first = {
        from: '2026-10-12T17:00:00Z',
        until: '2026-10-12T21:00:00Z',
      },
      second = { from: '2026-10-12T21:00:00Z', until: '2026-10-13T01:00:00Z' };
    return {
      day,
      halves: workFirst
        ? [
            { kind: 'work', interval: first },
            { kind: 'leave', interval: second, approval },
          ]
        : [
            { kind: 'leave', interval: first, approval },
            { kind: 'work', interval: second },
          ],
      breaks: [{ from: '2026-10-12T20:45:00Z', until: '2026-10-12T21:15:00Z' }],
    };
  }
  it.each([false, true])(
    'composes paid half-day leave and work without a second absence, work-first=%s',
    (workFirst) => {
      const input = composition(workFirst),
        original = structuredClone(input);
      const result = previewAttendanceLeaveComposition(input);
      expect(result).toMatchObject({
        status: 'composed_candidate',
        qualification: 'half_day_work',
        workUnits: 0.5,
        paidLeaveUnits: 0.5,
        unpaidLeaveUnits: 0,
        uncoveredAbsenceUnits: 0,
        workedMinutes: 225,
        eligibleWorkedMinutes: 225,
        breakDeductedMilliseconds: 15 * 60000,
        plannedWorkMilliseconds: 225 * 60000,
        isLate: false,
        isEarly: false,
        policyId: policy.id,
        policyVersion: 1,
        leaveApprovalVersion: 1,
        overtimePayable: false,
        attendanceProcessingAvailable: false,
        payrollEffectsAvailable: false,
      });
      expect(input).toEqual(original);
      if (result.status !== 'composed_candidate')
        throw new Error('Unexpected review');
      result.punchReferences[0].mappingVersion = 9;
      result.breakWindows[0].from = 'changed';
      expect(input).toEqual(original);
    },
  );
  it('keeps approved unpaid leave separate from absence', () => {
    expect(
      previewAttendanceLeaveComposition(composition(false, 'unpaid')),
    ).toMatchObject({
      workUnits: 0.5,
      paidLeaveUnits: 0,
      unpaidLeaveUnits: 0.5,
      uncoveredAbsenceUnits: 0,
    });
  });
  it.each([
    [-1, 'insufficient_work', 0.5],
    [0, 'half_day_work', 0],
    [1, 'half_day_work', 0],
  ])(
    'uses the half minimum without double-deducting breaks at millisecond boundary %s',
    (delta, qualification, absence) => {
      const input = composition();
      input.day.punches[1] = punch(
        new Date(
          Date.parse('2026-10-13T02:00:00Z') + (180 + 15) * 60000 + delta,
        )
          .toISOString()
          .slice(0, -1),
        'out',
        2,
      );
      expect(previewAttendanceLeaveComposition(input)).toMatchObject({
        qualification,
        uncoveredAbsenceUnits: absence,
        paidLeaveUnits: 0.5,
        workedMilliseconds: 180 * 60000 + delta,
        eligibleWorkedMilliseconds: 180 * 60000 + delta,
      });
    },
  );
  it('only charges uncovered work-half candidates when no punches have complete coverage', () => {
    const input = composition();
    input.day.punches = [];
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      qualification: 'no_punch_work',
      workUnits: 0,
      paidLeaveUnits: 0.5,
      uncoveredAbsenceUnits: 0.5,
      workedMinutes: 0,
    });
    input.day.coverageMapping = null;
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      status: 'needs_review',
      attendanceReviewCode: 'mapping_unresolved',
      uncoveredAbsenceUnits: null,
    });
  });
  it('uses actual break overlap rather than subtracting an entire day break from a short span', () => {
    const input = composition();
    input.day.punches = [
      punch('2026-10-13T03:00:00', 'in', 1),
      punch('2026-10-13T03:10:00', 'out', 2),
    ];
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      workedMinutes: 10,
      breakDeductedMilliseconds: 0,
      qualification: 'insufficient_work',
      uncoveredAbsenceUnits: 0.5,
    });
  });
  it('keeps overtime non-payable and outside work-half minimum qualification', () => {
    const input = composition(true);
    input.day.punches[0] = punch('2026-10-12T21:45:00', 'in', 1);
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      workedMinutes: 240,
      eligibleWorkedMinutes: 225,
      overtimeCandidateMilliseconds: 15 * 60000,
      overtimePayable: false,
    });
  });
  it.each([0, 1])(
    'computes grace against the work half without inventing work, delta=%s',
    (delta) => {
      const input = composition();
      input.day.punches[0] = punch(
        '2026-10-13T02:10:00' + (delta ? '.001' : ''),
        'in',
        1,
      );
      expect(previewAttendanceLeaveComposition(input)).toMatchObject({
        lateMilliseconds: 10 * 60000 + delta,
        isLate: !!delta,
        workedMilliseconds: 225 * 60000,
        eligibleWorkedMilliseconds: 225 * 60000,
      });
      // The check-in remained within the explicitly unpaid 02:00–02:15 break;
      // no work was manufactured by grace or removed twice as another break.
    },
  );
  it('retains exact retry and out-of-order behavior of the canonical evidence validator', () => {
    const input = composition(),
      original = previewAttendanceLeaveComposition(input);
    input.day.punches = [
      input.day.punches[1],
      input.day.punches[0],
      structuredClone(input.day.punches[0]),
    ];
    input.halves.reverse();
    expect(previewAttendanceLeaveComposition(input)).toEqual(original);
  });
  it('canonicalizes two explicitly placed breaks without changing net half-day coverage', () => {
    const input = composition();
    input.breaks = [
      { from: '2026-10-12T17:45:00Z', until: '2026-10-12T18:00:00Z' },
      { from: '2026-10-12T21:45:00Z', until: '2026-10-12T22:00:00Z' },
    ];
    const original = previewAttendanceLeaveComposition(input);
    expect(original).toMatchObject({
      qualification: 'half_day_work',
      workedMinutes: 225,
      uncoveredAbsenceUnits: 0,
    });
    input.breaks.reverse();
    expect(previewAttendanceLeaveComposition(input)).toEqual(original);
  });
  it.each(['pending', 'rejected', 'cancelled'])(
    'withholds all absence units for %s approval',
    (status) => {
      const input = composition();
      input.halves[0].approval!.status = status;
      expect(previewAttendanceLeaveComposition(input)).toMatchObject({
        code: 'approval_unresolved',
        uncoveredAbsenceUnits: null,
        workedMinutes: null,
      });
    },
  );
  it('rejects foreign leave scope and missing approvals rather than accept caller authority', () => {
    for (const field of ['tenantId', 'employeeId', 'workDate'] as const) {
      const input = composition();
      input.halves[0].approval![field] =
        field === 'workDate' ? '2026-10-13' : policy.id;
      expect(() => previewAttendanceLeaveComposition(input)).toThrow(
        'LEAVE_SCOPE_MISMATCH',
      );
    }
    const input = composition();
    const halves = input.halves.map((v) =>
      v.kind === 'leave' ? { ...v, approval: null } : v,
    );
    expect(
      previewAttendanceLeaveComposition({ ...input, halves }),
    ).toMatchObject({ code: 'approval_unresolved' });
  });
  it('keeps locked, incomplete, missing-punch and unknown calendar evidence unresolved', () => {
    const input = composition();
    input.day.periodState = 'locked';
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      attendanceReviewCode: 'locked_period',
    });
    input.day.periodState = 'open';
    input.day.evidence = 'incomplete';
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      attendanceReviewCode: 'incomplete_evidence',
    });
    input.day.evidence = 'complete_closed';
    input.day.punches.pop();
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      attendanceReviewCode: 'missing_punch',
    });
    input.day.punches = composition().day.punches;
    input.day.calendar = 'unknown';
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      attendanceReviewCode: 'calendar_unknown',
    });
    input.day.calendar = 'holiday';
    input.day.punches = [];
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      code: 'non_working_day',
    });
  });
  it('does not reinterpret a normal/full-leave day as this partial-leave workflow', () => {
    for (const leave of ['none', 'approved_full_day']) {
      const input = composition();
      input.day.leave = leave;
      expect(previewAttendanceLeaveComposition(input)).toMatchObject({
        code: 'leave_mode_mismatch',
      });
    }
  });
  it('refuses work overlapping leave, including a millisecond at the shared boundary', () => {
    const input = composition();
    input.day.punches[0] = punch('2026-10-13T01:59:59.999', 'in', 1);
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      code: 'work_leave_overlap',
      uncoveredAbsenceUnits: null,
    });
    const first = composition(true);
    first.day.punches[1] = punch('2026-10-13T02:00:00.001', 'out', 2);
    expect(previewAttendanceLeaveComposition(first)).toMatchObject({
      code: 'work_leave_overlap',
    });
  });
  it('refuses gaps, overlapping halves, unequal net halves and missing/extra/overlapping breaks', () => {
    const mutations = [
      (v: ReturnType<typeof composition>) => {
        v.halves[1].interval.from = '2026-10-12T21:01:00Z';
      },
      (v: ReturnType<typeof composition>) => {
        v.halves[1].interval.from = '2026-10-12T20:59:00Z';
      },
      (v: ReturnType<typeof composition>) => {
        v.halves[0].interval.from = '2026-10-12T16:59:00Z';
      },
      (v: ReturnType<typeof composition>) => {
        v.breaks = [];
      },
      (v: ReturnType<typeof composition>) => {
        v.breaks[0].until = '2026-10-12T21:16:00Z';
      },
      (v: ReturnType<typeof composition>) => {
        v.breaks.push({ ...v.breaks[0] });
      },
      (v: ReturnType<typeof composition>) => {
        v.breaks[0].from = '2026-10-12T16:45:00Z';
        v.breaks[0].until = '2026-10-12T17:15:00Z';
      },
      (v: ReturnType<typeof composition>) => {
        v.halves[0].interval.until = '2026-10-12T22:00:00Z';
        v.halves[1].interval.from = '2026-10-12T22:00:00Z';
      },
      (v: ReturnType<typeof composition>) => {
        v.halves[0].kind = 'work';
        delete v.halves[0].approval;
      },
    ];
    for (const mutate of mutations) {
      const input = composition();
      mutate(input);
      expect(previewAttendanceLeaveComposition(input)).toMatchObject({
        code: 'partition_invalid',
      });
    }
  });
  it('preserves previously returned timing/approval references when a later preview changes versions', () => {
    const input = composition();
    const original = previewAttendanceLeaveComposition(input);
    input.day.schedules[0].policy.version = 2;
    input.day.schedules[0].policy.basedOnVersion = 1;
    input.halves[0].approval!.version = 2;
    expect(previewAttendanceLeaveComposition(input)).toMatchObject({
      policyVersion: 2,
      leaveApprovalVersion: 2,
    });
    expect(original).toMatchObject({
      policyVersion: 1,
      leaveApprovalVersion: 1,
    });
  });
  it('rejects contradictory composition responses and malformed plan inputs', () => {
    const result = previewAttendanceLeaveComposition(composition());
    if (result.status !== 'composed_candidate')
      throw new Error('Unexpected review');
    for (const corrupt of [
      { ...result, uncoveredAbsenceUnits: 0.5 },
      { ...result, workUnits: 0 },
      { ...result, paidLeaveUnits: 0, unpaidLeaveUnits: 0 },
      { ...result, policyId: null },
      { ...result, punchReferences: [] },
      { ...result, firstPunchAt: null },
      { ...result, lastPunchAt: result.firstPunchAt },
      {
        ...result,
        breakDeductedMilliseconds: result.grossWorkedMilliseconds + 1,
      },
      { ...result, workedMilliseconds: 0 },
      { ...result, eligibleWorkedMilliseconds: result.workedMilliseconds + 1 },
      { ...result, plannedWorkMilliseconds: 0 },
      { ...result, workedMinutes: 226 },
      { ...result, eligibleWorkedMinutes: 226 },
      { ...result, overtimeCandidateMilliseconds: 1 },
      { ...result, qualification: 'no_punch_work' },
      {
        ...result,
        punchReferences: [result.punchReferences[0], result.punchReferences[0]],
      },
    ])
      expect(
        attendanceLeaveCompositionPreviewSchema.safeParse(corrupt).success,
      ).toBe(false);
    const precise = composition();
    precise.breaks[0].from = '2026-10-12T20:45:00.0001Z';
    expect(() => previewAttendanceLeaveComposition(precise)).toThrow();
    const absent = composition();
    absent.day.punches = [];
    const absence = previewAttendanceLeaveComposition(absent);
    for (const corrupt of [
      { ...absence, isLate: true },
      { ...absence, isEarly: true },
      { ...absence, lateMilliseconds: 1 },
      { ...absence, earlyMilliseconds: 1 },
    ])
      expect(
        attendanceLeaveCompositionPreviewSchema.safeParse(corrupt).success,
      ).toBe(false);
    expect(
      attendanceLeaveCompositionPreviewSchema.safeParse({
        ...absence,
        coverageMappingId: null,
      }).success,
    ).toBe(false);
    for (const input of [
      null,
      {},
      { ...composition(), halves: [] },
      {
        ...composition(),
        breaks: [
          { from: '2026-10-12T20:45:00.001Z', until: '2026-10-12T21:15:00Z' },
        ],
      },
      {
        ...composition(),
        breaks: [
          { from: '2026-10-12T21:15:00Z', until: '2026-10-12T20:45:00Z' },
        ],
      },
      { ...composition(), payrollEffectsAvailable: true },
    ])
      expect(() => previewAttendanceLeaveComposition(input)).toThrow();
  });
});

describe('company leave policy and all-bucket quota preview', () => {
  const tenantId = '30000000-0000-4000-8000-000000000001',
    employeeId = '30000000-0000-4000-8000-000000000002',
    leaveTypeId = '30000000-0000-4000-8000-000000000003',
    requestId = '30000000-0000-4000-8000-000000000004';
  const settings = {
    scope: 'company',
    timeZone: 'Asia/Karachi',
    code: 'CASUAL',
    name: 'Casual leave',
    pay: 'paid',
    grantMode: 'annual_upfront',
    annualQuotaDays: 12,
    monthlyQuotaDays: 2,
    leaveYearStart: { month: 1, day: 1 },
    nonWorkingDays: 'exclude',
  };
  const date = (value = '2026-10-12', part = 'full_day') => ({
    date: value,
    part,
    calendar: 'working_day',
    periodState: 'open',
  });
  const fixture = () => ({
    policy: {
      id: '30000000-0000-4000-8000-000000000005',
      tenantId,
      leaveTypeId,
      version: 1,
      status: 'published',
      effectiveFrom: '2026-01-01',
      effectiveUntil: null as string | null,
      settings: structuredClone(settings),
    },
    request: {
      tenantId,
      employeeId,
      leaveTypeId,
      requestId,
      expectedUsageVersion: 1,
      dates: [date()],
    },
    usage: {
      tenantId,
      employeeId,
      leaveTypeId,
      version: 1,
      leaveYearStart: { month: 1, day: 1 },
      annual: [
        {
          from: '2026-01-01',
          until: '2027-01-01',
          reservedDays: 0,
          usedDays: 0,
        },
      ],
      monthly: [{ month: '2026-10', reservedDays: 0, usedDays: 0 }],
      occupied: [] as { requestId: string; date: string; part: string }[],
    },
  });
  it('requires explicit employer quotas/year/calendar rules without statutory defaults', () => {
    expect(
      leavePolicyDraftSchema.parse({
        expectedCurrentVersion: 0,
        effectiveFrom: '2026-01-01',
        settings,
        reason: ' Reviewed company policy ',
      }).reason,
    ).toBe('Reviewed company policy');
    for (const bad of [
      null,
      {},
      { ...settings, annualQuotaDays: 2.25 },
      { ...settings, monthlyQuotaDays: '2' },
      { ...settings, monthlyQuotaDays: 32 },
      { ...settings, annualQuotaDays: -1 },
      { ...settings, annualQuotaDays: 367 },
      { ...settings, scope: 'employee' },
      { ...settings, employeeOverride: true },
      { ...settings, grantMode: 'monthly_accrual' },
      { ...settings, leaveYearStart: { month: 2, day: 29 } },
      { ...settings, leaveYearStart: { month: 4, day: 31 } },
    ])
      expect(leavePolicySettingsSchema.safeParse(bad).success).toBe(false);
    expect(
      leavePolicySettingsSchema.safeParse({
        ...settings,
        annualQuotaDays: 0,
        monthlyQuotaDays: 0,
      }).success,
    ).toBe(true);
  });
  it('returns exact annual/monthly reservation candidates without mutating counters', () => {
    const input = fixture(),
      original = structuredClone(input);
    const result = previewLeaveQuota(input);
    expect(result).toMatchObject({
      status: 'reservation_candidate',
      expectedUsageVersion: 1,
      policyVersion: 1,
      totalRequestedDays: 1,
      pay: 'paid',
      annual: [
        { requestedDays: 1, availableBeforeDays: 12, availableAfterDays: 11 },
      ],
      monthly: [
        {
          month: '2026-10',
          requestedDays: 1,
          availableBeforeDays: 2,
          availableAfterDays: 1,
        },
      ],
      leaveReservationAvailable: false,
      payrollEffectsAvailable: false,
    });
    if (result.status !== 'reservation_candidate')
      throw new Error('Unexpected rejection');
    result.annual[0].requestedDays = 99;
    expect(input).toEqual(original);
  });
  it.each(['full_day', 'first_half'])(
    'permits exactly two monthly days using %s requests and rejects the next half day',
    (part) => {
      const input = fixture();
      input.request.dates = Array.from(
        { length: part === 'full_day' ? 2 : 4 },
        (_, i) => date(`2026-10-${12 + i}`, part),
      );
      expect(previewLeaveQuota(input)).toMatchObject({
        totalRequestedDays: 2,
        monthly: [{ availableAfterDays: 0 }],
      });
      input.request.dates.push(date('2026-10-20', 'second_half'));
      expect(previewLeaveQuota(input)).toMatchObject({
        status: 'quota_exceeded',
        code: 'LEAVE_MONTHLY_QUOTA_EXCEEDED',
        requestedDays: 2.5,
        availableDays: 2,
      });
    },
  );
  it.each([
    [2, 0],
    [0, 2],
    [1, 1],
  ])(
    'counts reserved=%s and used=%s exactly once against monthly availability',
    (reservedDays, usedDays) => {
      const input = fixture();
      input.usage.monthly[0] = { month: '2026-10', reservedDays, usedDays };
      input.usage.annual[0].reservedDays = reservedDays;
      input.usage.annual[0].usedDays = usedDays;
      expect(previewLeaveQuota(input)).toMatchObject({
        code: 'LEAVE_MONTHLY_QUOTA_EXCEEDED',
        availableDays: 0,
        reservedDays,
        usedDays,
      });
    },
  );
  it('blocks annual exhaustion even when the month has room and retains usage after policy reduction', () => {
    const input = fixture();
    input.usage.annual[0].usedDays = 12;
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_ANNUAL_QUOTA_EXCEEDED',
      availableDays: 0,
    });
    input.policy.version = 2;
    input.policy.settings.annualQuotaDays = 10;
    expect(previewLeaveQuota(input)).toMatchObject({
      policyVersion: 2,
      usedDays: 12,
      overLimitDays: 2,
    });
    const monthly = fixture();
    monthly.usage.monthly[0].usedDays = 3;
    expect(previewLeaveQuota(monthly)).toMatchObject({
      code: 'LEAVE_MONTHLY_QUOTA_EXCEEDED',
      usedDays: 3,
      overLimitDays: 1,
    });
  });
  it('splits cross-month demand atomically in the plan without rolling monthly allowance forward', () => {
    const input = fixture();
    input.request.dates = [date('2026-11-01'), date('2026-10-31')];
    input.usage.monthly.push({
      month: '2026-11',
      reservedDays: 0,
      usedDays: 0,
    });
    const result = previewLeaveQuota(input);
    expect(result).toMatchObject({
      totalRequestedDays: 2,
      annual: [{ requestedDays: 2 }],
      monthly: [
        { month: '2026-10', requestedDays: 1 },
        { month: '2026-11', requestedDays: 1 },
      ],
    });
    input.usage.monthly[1].usedDays = 2;
    const original = structuredClone(input);
    const denied = previewLeaveQuota(input);
    expect(denied).toMatchObject({
      code: 'LEAVE_MONTHLY_QUOTA_EXCEEDED',
      period: '2026-11',
    });
    expect('annual' in denied).toBe(false);
    expect(input).toEqual(original);
  });
  it('splits January leave years and a reviewed July leave year using dates taken', () => {
    const input = fixture();
    input.request.dates = [
      date('2026-12-31', 'first_half'),
      date('2027-01-01', 'second_half'),
    ];
    input.usage.annual.push({
      from: '2027-01-01',
      until: '2028-01-01',
      reservedDays: 0,
      usedDays: 0,
    });
    input.usage.monthly = [
      { month: '2026-12', reservedDays: 0, usedDays: 0 },
      { month: '2027-01', reservedDays: 0, usedDays: 0 },
    ];
    expect(previewLeaveQuota(input)).toMatchObject({
      totalRequestedDays: 1,
      annual: [
        { from: '2026-01-01', requestedDays: 0.5 },
        { from: '2027-01-01', requestedDays: 0.5 },
      ],
    });
    input.policy.settings.leaveYearStart = { month: 7, day: 1 };
    input.usage.leaveYearStart = { month: 7, day: 1 };
    input.request.dates = [date('2026-06-30'), date('2026-07-01')];
    input.usage.annual = [
      { from: '2025-07-01', until: '2026-07-01', reservedDays: 0, usedDays: 0 },
      { from: '2026-07-01', until: '2027-07-01', reservedDays: 0, usedDays: 0 },
    ];
    input.usage.monthly = [
      { month: '2026-06', reservedDays: 0, usedDays: 0 },
      { month: '2026-07', reservedDays: 0, usedDays: 0 },
    ];
    expect(previewLeaveQuota(input)).toMatchObject({
      annual: [{ from: '2025-07-01' }, { from: '2026-07-01' }],
    });
  });
  it('splits a custom leave-year boundary inside one calendar month', () => {
    const input = fixture();
    input.policy.settings.leaveYearStart = { month: 10, day: 15 };
    input.usage.leaveYearStart = { month: 10, day: 15 };
    input.request.dates = [
      date('2026-10-14', 'first_half'),
      date('2026-10-15', 'first_half'),
    ];
    input.usage.annual = [
      { from: '2025-10-15', until: '2026-10-15', reservedDays: 0, usedDays: 0 },
      { from: '2026-10-15', until: '2027-10-15', reservedDays: 0, usedDays: 0 },
    ];
    expect(previewLeaveQuota(input)).toMatchObject({
      annual: [{ requestedDays: 0.5 }, { requestedDays: 0.5 }],
      monthly: [{ month: '2026-10', requestedDays: 1 }],
    });
  });
  it('handles leap days without using host time or submission dates', () => {
    const input = fixture();
    input.policy.effectiveFrom = '2024-01-01';
    input.request.dates = [date('2024-02-29'), date('2024-03-01')];
    input.usage.annual = [
      { from: '2024-01-01', until: '2025-01-01', reservedDays: 0, usedDays: 0 },
    ];
    input.usage.monthly = [
      { month: '2024-02', reservedDays: 0, usedDays: 0 },
      { month: '2024-03', reservedDays: 0, usedDays: 0 },
    ];
    expect(previewLeaveQuota(input)).toMatchObject({
      totalRequestedDays: 2,
      monthly: [{ month: '2024-02' }, { month: '2024-03' }],
    });
    input.request.dates = [date('2025-02-29')];
    expect(() => previewLeaveQuota(input)).toThrow();
  });
  it('excludes reviewed non-working dates or explicitly charges them, never guesses unknown calendars', () => {
    const input = fixture();
    input.request.dates = [
      date('2026-10-12'),
      { ...date('2026-10-13'), calendar: 'holiday' },
      { ...date('2026-10-14'), calendar: 'rest_day' },
    ];
    expect(previewLeaveQuota(input)).toMatchObject({
      totalRequestedDays: 1,
      excludedDates: ['2026-10-13', '2026-10-14'],
    });
    input.policy.settings.nonWorkingDays = 'include';
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_MONTHLY_QUOTA_EXCEEDED',
      requestedDays: 3,
    });
    input.request.dates[0].calendar = 'unknown';
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_CALENDAR_UNRESOLVED',
    });
    input.request.dates[0].calendar = 'not_employed';
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_NOT_EMPLOYED',
    });
    input.policy.settings.nonWorkingDays = 'exclude';
    input.request.dates = [{ ...date(), calendar: 'holiday' }];
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_NO_CHARGEABLE_DATES',
    });
  });
  it('uses unpaid request quotas without claiming a paid balance debit', () => {
    const input = fixture();
    input.policy.settings.pay = 'unpaid';
    expect(previewLeaveQuota(input)).toMatchObject({
      status: 'reservation_candidate',
      pay: 'unpaid',
      leaveReservationAvailable: false,
      payrollEffectsAvailable: false,
    });
  });
  it('denies full/same-half overlaps but permits the opposite half within quota', () => {
    const input = fixture();
    input.usage.occupied.push({
      requestId: input.policy.id,
      date: '2026-10-12',
      part: 'first_half',
    });
    expect(previewLeaveQuota(input)).toMatchObject({ code: 'LEAVE_OVERLAP' });
    input.request.dates[0].part = 'first_half';
    expect(previewLeaveQuota(input)).toMatchObject({ code: 'LEAVE_OVERLAP' });
    input.request.dates[0].part = 'second_half';
    expect(previewLeaveQuota(input)).toMatchObject({ totalRequestedDays: 0.5 });
    input.usage.occupied[0].part = 'full_day';
    expect(previewLeaveQuota(input)).toMatchObject({ code: 'LEAVE_OVERLAP' });
  });
  it('refuses stale snapshots, leave-year changes and missing annual/month buckets instead of zero defaults', () => {
    const input = fixture();
    input.usage.version = 2;
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_STALE',
    });
    input.usage.version = 1;
    input.usage.leaveYearStart.day = 2;
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_YEAR_CHANGE_REQUIRES_RECONCILIATION',
    });
    input.usage.leaveYearStart.day = 1;
    input.usage.annual = [];
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
    input.usage.annual = fixture().usage.annual;
    input.usage.monthly = [];
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
  });
  it('requires policy-span splitting and reviewed correction for locked leave dates', () => {
    const input = fixture();
    input.policy.effectiveUntil = '2026-10-12';
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_POLICY_CHANGE_REQUIRES_SPLIT',
    });
    input.policy.effectiveUntil = null;
    input.request.dates[0].date = '2025-12-31';
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_POLICY_CHANGE_REQUIRES_SPLIT',
    });
    input.request.dates[0] = { ...date(), periodState: 'locked' };
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_PERIOD_LOCKED',
    });
  });
  it('rejects duplicate dates, excessive spans and corrupted counter periods', () => {
    const input = fixture();
    input.request.dates.push(date());
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_INVALID_REQUEST',
    });
    input.request.dates = [date('2026-10-12'), date('2027-10-13')];
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_INVALID_REQUEST',
    });
    input.request.dates = [date()];
    input.usage.annual.push({ ...input.usage.annual[0] });
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
    input.usage.annual = fixture().usage.annual;
    input.usage.monthly.push({ ...input.usage.monthly[0] });
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
    input.usage.monthly = fixture().usage.monthly;
    input.usage.annual[0].until = '2027-01-02';
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
    input.usage.annual = fixture().usage.annual;
    input.usage.monthly[0].reservedDays = 31;
    input.usage.monthly[0].usedDays = 31;
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
    input.usage.monthly = fixture().usage.monthly;
    input.usage.annual[0].usedDays = 366;
    input.usage.annual[0].reservedDays = 1;
    expect(previewLeaveQuota(input)).toMatchObject({
      code: 'LEAVE_USAGE_UNRESOLVED',
    });
  });
  it('keeps companies, employees and leave types independent and rejects forged bypass fields', () => {
    for (const altered of ['tenantId', 'employeeId', 'leaveTypeId'] as const) {
      const input = fixture();
      input.usage[altered] = requestId;
      expect(() => previewLeaveQuota(input)).toThrow('LEAVE_SCOPE_MISMATCH');
    }
    const input = fixture();
    input.policy.leaveTypeId = requestId;
    expect(() => previewLeaveQuota(input)).toThrow('LEAVE_SCOPE_MISMATCH');
    for (const bad of [
      { ...fixture(), bypassQuota: true },
      { ...fixture(), request: { ...fixture().request, role: 'hr_admin' } },
      {
        ...fixture(),
        request: { ...fixture().request, replaceRequestId: requestId },
      },
      { ...fixture(), policy: { ...fixture().policy, status: 'draft' } },
      {
        ...fixture(),
        usage: {
          ...fixture().usage,
          monthly: [{ month: '2026-13', reservedDays: 0, usedDays: 0 }],
        },
      },
    ])
      expect(() => previewLeaveQuota(bad)).toThrow();
    const second = fixture();
    second.policy.leaveTypeId = employeeId;
    second.request.leaveTypeId = employeeId;
    second.usage.leaveTypeId = employeeId;
    second.policy.settings.code = 'SICK';
    second.policy.settings.monthlyQuotaDays = 1;
    expect(previewLeaveQuota(second)).toMatchObject({
      leaveTypeId: employeeId,
      monthly: [{ quotaDays: 1 }],
    });
    expect(previewLeaveQuota(fixture())).toMatchObject({
      leaveTypeId,
      monthly: [{ quotaDays: 2 }],
    });
  });
  it('is deterministic under input reordering and rejects contradictory reservation responses', () => {
    const input = fixture();
    input.request.dates = [
      date('2026-10-13', 'first_half'),
      date('2026-10-12', 'second_half'),
    ];
    const original = previewLeaveQuota(input);
    input.request.dates.reverse();
    expect(previewLeaveQuota(input)).toEqual(original);
    if (original.status !== 'reservation_candidate')
      throw new Error('Unexpected review');
    for (const bad of [
      { ...original, totalRequestedDays: 2 },
      { ...original, annual: [{ ...original.annual[0], requestedDays: 0 }] },
      {
        ...original,
        monthly: [{ ...original.monthly[0], availableAfterDays: 0 }],
      },
      {
        ...original,
        annual: [{ ...original.annual[0], availableBeforeDays: 99 }],
      },
      {
        ...original,
        chargeableDates: [
          original.chargeableDates[0],
          original.chargeableDates[0],
        ],
      },
      {
        ...original,
        chargeableDates: [
          { ...original.chargeableDates[0], part: 'full_day' },
          original.chargeableDates[1],
        ],
      },
    ])
      expect(leaveQuotaPreviewSchema.safeParse(bad).success).toBe(false);
  });
});

describe('pure leave decision and ledger-delta preparation', () => {
  const tenantId = '40000000-0000-4000-8000-000000000001',
    employeeId = '40000000-0000-4000-8000-000000000002',
    employeeIdentityId = '40000000-0000-4000-8000-000000000003',
    manager = '40000000-0000-4000-8000-000000000004',
    hr = '40000000-0000-4000-8000-000000000005',
    other = '40000000-0000-4000-8000-000000000006';
  function fixture() {
    return leaveLifecycleInputSchema.parse({
      request: {
        tenantId,
        employeeId,
        employeeIdentityId,
        submittedBy: employeeIdentityId,
        requestId: '40000000-0000-4000-8000-000000000007',
        leaveTypeId: '40000000-0000-4000-8000-000000000008',
        policyId: '40000000-0000-4000-8000-000000000009',
        policyVersion: 2,
        version: 3,
        status: 'pending',
        pay: 'paid',
        leaveYearStart: { month: 1, day: 1 },
        dates: [
          { date: '2026-12-31', part: 'full_day', chargeable: true },
          { date: '2027-01-01', part: 'first_half', chargeable: true },
          { date: '2027-01-02', part: 'full_day', chargeable: false },
        ],
      },
      command: {
        tenantId,
        employeeId,
        requestId: '40000000-0000-4000-8000-000000000007',
        actorId: manager,
        expectedVersion: 3,
        expectedRoutingVersion: 5,
        action: 'approve',
      },
      context: {
        tenantId,
        employeeId,
        routingVersion: 5,
        eligibleManagerId: manager,
        eligibleHrIds: [hr],
        periods: ['2026-12-31', '2027-01-01', '2027-01-02'].map((date) => ({
          date,
          state: 'open',
        })),
      },
    });
  }
  it('converts reservations to consumption once per month/year without another debit', () => {
    const input = fixture(),
      before = structuredClone(input);
    const result = previewLeaveDecision(input);
    expect(result).toMatchObject({
      status: 'transition_candidate',
      expectedVersion: 3,
      nextVersion: 4,
      expectedRoutingVersion: 5,
      nextStatus: 'approved',
      occupancy: 'retain',
      policyVersion: 2,
      pay: 'paid',
      leaveReservationAvailable: false,
      payrollEffectsAvailable: false,
      deltas: [
        {
          bucket: 'annual',
          period: '2026-01-01',
          reservedHalfUnits: -2,
          usedHalfUnits: 2,
        },
        {
          bucket: 'annual',
          period: '2027-01-01',
          reservedHalfUnits: -1,
          usedHalfUnits: 1,
        },
        {
          bucket: 'monthly',
          period: '2026-12',
          reservedHalfUnits: -2,
          usedHalfUnits: 2,
        },
        {
          bucket: 'monthly',
          period: '2027-01',
          reservedHalfUnits: -1,
          usedHalfUnits: 1,
        },
      ],
    });
    expect(input).toEqual(before);
    expect(previewLeaveDecision(input)).toEqual(result);
    // Determinism is NOT receipt replay: a second committed decision must be stale.
    input.request.version = 4;
    input.request.status = 'approved';
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_REQUEST_STALE',
    });
    input.command.expectedVersion = 4;
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_INVALID_TRANSITION',
    });
  });
  it.each(['reject', 'cancel'] as const)(
    '%s releases pending units without consuming and releases occupancy',
    (action) => {
      const input = fixture();
      input.command.action = action;
      if (action === 'cancel') input.command.actorId = employeeIdentityId;
      const result = previewLeaveDecision(input);
      expect(result).toMatchObject({
        status: 'transition_candidate',
        nextStatus: action === 'reject' ? 'rejected' : 'cancelled',
        occupancy: 'release',
      });
      if (result.status !== 'transition_candidate')
        throw new Error('Missing plan');
      expect(
        result.deltas.every(
          (d) => d.usedHalfUnits === 0 && d.reservedHalfUnits < 0,
        ),
      ).toBe(true);
    },
  );
  it('allows HR fallback only when there is no eligible reporting manager', () => {
    const input = fixture();
    input.command.actorId = hr;
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_DECISION_FORBIDDEN',
    });
    input.context.eligibleManagerId = null;
    expect(previewLeaveDecision(input)).toMatchObject({
      nextStatus: 'approved',
    });
    input.command.actorId = manager;
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_DECISION_FORBIDDEN',
    });
  });
  it.each(['approve', 'reject'] as const)(
    'prevents self-%s even with manager/HR authority',
    (action) => {
      const input = fixture();
      input.command.action = action;
      input.command.actorId = employeeIdentityId;
      input.context.eligibleManagerId = employeeIdentityId;
      expect(previewLeaveDecision(input)).toMatchObject({
        code: 'LEAVE_DECISION_FORBIDDEN',
      });
      input.context.eligibleManagerId = null;
      input.context.eligibleHrIds.push(employeeIdentityId);
      expect(previewLeaveDecision(input)).toMatchObject({
        code: 'LEAVE_DECISION_FORBIDDEN',
      });
      input.command.actorId = hr;
      input.request.submittedBy = hr;
      expect(previewLeaveDecision(input)).toMatchObject({
        code: 'LEAVE_DECISION_FORBIDDEN',
      });
    },
  );
  it('allows pending cancellation by original submitter or eligible HR, not manager alone', () => {
    const input = fixture();
    input.command.action = 'cancel';
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_DECISION_FORBIDDEN',
    });
    input.command.actorId = hr;
    expect(previewLeaveDecision(input)).toMatchObject({
      nextStatus: 'cancelled',
    });
    input.request.submittedBy = other;
    input.command.actorId = other;
    expect(previewLeaveDecision(input)).toMatchObject({
      nextStatus: 'cancelled',
    });
  });
  it('denies unauthorized callers before disclosing versions or terminal states', () => {
    const input = fixture();
    input.command.actorId = other;
    input.request.version = 4;
    input.request.status = 'approved';
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_DECISION_FORBIDDEN',
    });
  });
  it('requires a separately approved reversal for approved cancellation', () => {
    const input = fixture();
    input.request.status = 'approved';
    input.command.action = 'cancel';
    input.command.actorId = employeeIdentityId;
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_APPROVED_REVERSAL_REQUIRED',
    });
  });
  it.each(['rejected', 'cancelled'] as const)(
    'does not reopen or release terminal %s requests',
    (status) => {
      const input = fixture();
      input.request.status = status;
      expect(previewLeaveDecision(input)).toMatchObject({
        code: 'LEAVE_INVALID_TRANSITION',
      });
    },
  );
  it('fails closed on stale routing and version exhaustion', () => {
    const input = fixture();
    input.context.routingVersion++;
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_ROUTING_STALE',
    });
    input.command.expectedRoutingVersion++;
    input.request.version = input.command.expectedVersion = 2147483647;
    expect(previewLeaveDecision(input)).toMatchObject({
      code: 'LEAVE_VERSION_EXHAUSTED',
    });
  });
  it.each(['approve', 'reject', 'cancel'] as const)(
    'blocks %s across any locked date, including nonchargeable dates',
    (action) => {
      const input = fixture();
      input.command.action = action;
      if (action === 'cancel') input.command.actorId = hr;
      input.context.periods[2].state = 'locked';
      const result = previewLeaveDecision(input);
      expect(result).toMatchObject({
        status: 'needs_review',
        code: 'LEAVE_PERIOD_LOCKED',
      });
      expect(result).not.toHaveProperty('deltas');
    },
  );
  it('refuses missing, unknown, extra or mismatched period evidence', () => {
    for (const mode of ['missing', 'unknown', 'extra', 'wrong']) {
      const input = fixture();
      if (mode === 'missing') input.context.periods.pop();
      if (mode === 'unknown') input.context.periods[0].state = 'unknown';
      if (mode === 'extra')
        input.context.periods.push({ date: '2027-01-03', state: 'open' });
      if (mode === 'wrong') input.context.periods[0].date = '2026-12-30';
      expect(previewLeaveDecision(input)).toMatchObject({
        code: 'LEAVE_PERIOD_UNRESOLVED',
      });
    }
  });
  it('groups historical custom leave years and leap-day halves deterministically', () => {
    const input = fixture();
    input.request.pay = 'unpaid';
    input.request.leaveYearStart = { month: 3, day: 15 };
    input.request.dates = [
      { date: '2028-03-15', part: 'second_half', chargeable: true },
      { date: '2028-02-29', part: 'first_half', chargeable: true },
      { date: '2028-03-14', part: 'full_day', chargeable: true },
    ];
    input.context.periods = input.request.dates.map(({ date }) => ({
      date,
      state: 'open',
    }));
    const result = previewLeaveDecision(input);
    expect(result).toMatchObject({
      pay: 'unpaid',
      deltas: [
        {
          bucket: 'annual',
          period: '2027-03-15',
          reservedHalfUnits: -3,
          usedHalfUnits: 3,
        },
        {
          bucket: 'annual',
          period: '2028-03-15',
          reservedHalfUnits: -1,
          usedHalfUnits: 1,
        },
        {
          bucket: 'monthly',
          period: '2028-02',
          reservedHalfUnits: -1,
          usedHalfUnits: 1,
        },
        {
          bucket: 'monthly',
          period: '2028-03',
          reservedHalfUnits: -3,
          usedHalfUnits: 3,
        },
      ],
    });
  });
  it.each(['0001-01-01', '9999-12-31'])(
    'withholds unsupported leave-year allocation at %s',
    (date) => {
      const input = fixture();
      input.request.leaveYearStart = { month: 4, day: 1 };
      input.request.dates = [{ date, part: 'full_day', chargeable: true }];
      input.context.periods = [{ date, state: 'open' }];
      expect(previewLeaveDecision(input)).toMatchObject({
        code: 'LEAVE_ALLOCATION_UNRESOLVED',
      });
    },
  );
  it('rejects cross-company/employee/request snapshots', () => {
    for (const target of ['command', 'context'] as const) {
      for (const key of ['tenantId', 'employeeId'] as const) {
        const input = fixture();
        input[target][key] = other;
        expect(() => previewLeaveDecision(input)).toThrow(
          'LEAVE_SCOPE_MISMATCH',
        );
      }
    }
    const input = fixture();
    input.command.requestId = other;
    expect(() => previewLeaveDecision(input)).toThrow('LEAVE_SCOPE_MISMATCH');
  });
  it('rejects ambiguous snapshots and undeclared bypass/authority fields', () => {
    const before = fixture();
    const corruptions = [
      { ...before, trusted: true },
      { ...before, command: { ...before.command, override: true } },
      { ...before, context: { ...before.context, eligibleHrIds: [hr, hr] } },
      {
        ...before,
        context: {
          ...before.context,
          periods: [...before.context.periods, before.context.periods[0]],
        },
      },
      {
        ...before,
        request: {
          ...before.request,
          dates: [before.request.dates[0], before.request.dates[0]],
        },
      },
      {
        ...before,
        request: {
          ...before.request,
          dates: before.request.dates.map((d) => ({ ...d, chargeable: false })),
        },
      },
      {
        ...before,
        request: {
          ...before.request,
          dates: [{ date: '0000-01-01', part: 'full_day', chargeable: true }],
        },
      },
      {
        ...before,
        request: {
          ...before.request,
          dates: [
            { date: '2026-01-01', part: 'full_day', chargeable: true },
            { date: '2027-01-02', part: 'full_day', chargeable: true },
          ],
        },
      },
      {
        ...before,
        request: { ...before.request, leaveYearStart: { month: 2, day: 29 } },
      },
      { ...before, command: { ...before.command, expectedVersion: 0 } },
      { ...before, request: { ...before.request, status: 'draft' } },
    ];
    for (const bad of corruptions)
      expect(() => previewLeaveDecision(bad)).toThrow();
    expect(fixture()).toEqual(before);
  });
  it('validates transition arithmetic, occupancy and disabled effects', () => {
    const result = previewLeaveDecision(fixture());
    if (result.status !== 'transition_candidate')
      throw new Error('Missing plan');
    for (const bad of [
      { ...result, nextVersion: 3 },
      ...['2026-13', '0000-01', '2026-01-01'].map((period) => ({
        ...result,
        deltas: result.deltas.map((d) =>
          d.bucket === 'monthly' ? { ...d, period } : d,
        ),
      })),
      {
        ...result,
        deltas: result.deltas.map((d) => ({
          ...d,
          reservedHalfUnits: -64,
          usedHalfUnits: 64,
        })),
      },
      { ...result, occupancy: 'release' },
      { ...result, leaveReservationAvailable: true },
      { ...result, payrollEffectsAvailable: true },
      { ...result, deltas: [result.deltas[0]] },
      {
        ...result,
        deltas: result.deltas.map((d) => ({ ...d, usedHalfUnits: 0 })),
      },
      {
        ...result,
        deltas: result.deltas.map((d) => ({ ...d, usedHalfUnits: 1 })),
      },
      { ...result, deltas: [...result.deltas, result.deltas[0]] },
      { ...result, deltas: result.deltas.filter((d) => d.bucket === 'annual') },
      {
        ...result,
        deltas: result.deltas.map((d) =>
          d.bucket === 'monthly'
            ? { ...d, reservedHalfUnits: -4, usedHalfUnits: 4 }
            : d,
        ),
      },
    ])
      expect(leaveLifecyclePreviewSchema.safeParse(bad).success).toBe(false);
  });
});
