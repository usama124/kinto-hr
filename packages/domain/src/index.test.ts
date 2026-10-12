import { describe, expect, it } from 'vitest';
import { attendanceDayPreviewSchema } from '@kinto/contracts';
import {
  previewAttendanceTiming,
  previewAttendanceDay,
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
});
