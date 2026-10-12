import {
  attendanceLeaveCompositionInputSchema,
  attendanceLeaveCompositionPreviewSchema,
  type AttendanceLeaveCompositionPreview,
} from '@kinto/contracts';
import { previewAttendanceDay } from './attendance-day';
import { previewAttendanceScheduleWindow } from './attendance-normalization';
const overlap = (a: number, b: number, c: number, d: number) =>
  Math.max(0, Math.min(b, d) - Math.max(a, c));

// Compose one approved half-day leave with one work half. No quota/ledger write,
// absence settlement, salary calculation or unverified source promotion.
export function previewAttendanceLeaveComposition(
  input: unknown,
): AttendanceLeaveCompositionPreview {
  const parsed = attendanceLeaveCompositionInputSchema.parse(input),
    day = parsed.day;
  const selected = day.schedules.find((v) => v.workDate === day.workDate);
  const common = {
    tenantId: day.tenantId,
    deviceId: day.deviceId,
    employeeId: day.employeeId,
    workDate: day.workDate,
    calculationVersion: 1 as const,
    policyId: selected?.policy.id ?? null,
    policyVersion: selected?.policy.version ?? null,
    attendanceProcessingAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
  const review = (
    code:
      | 'attendance_unresolved'
      | 'non_working_day'
      | 'leave_mode_mismatch'
      | 'partition_invalid'
      | 'approval_unresolved'
      | 'work_leave_overlap',
    attendanceReviewCode:
      | Extract<
          ReturnType<typeof previewAttendanceDay>,
          { status: 'needs_review' }
        >['code']
      | null = null,
  ) =>
    attendanceLeaveCompositionPreviewSchema.parse({
      ...common,
      status: 'needs_review',
      code,
      attendanceReviewCode,
      uncoveredAbsenceUnits: null,
      workedMinutes: null,
    });
  for (const half of parsed.halves) {
    if (
      half.kind === 'leave' &&
      half.approval &&
      (half.approval.tenantId !== day.tenantId ||
        half.approval.employeeId !== day.employeeId ||
        half.approval.workDate !== day.workDate)
    )
      throw new Error('LEAVE_SCOPE_MISMATCH');
  }
  // Reuse canonical source/mapping, duplicate and punch-rule guards. Its full-day
  // break/qualification/absence totals are deliberately NOT merged into this result.
  const evidence = previewAttendanceDay({ ...day, leave: 'none' });
  if (evidence.status === 'needs_review')
    return review('attendance_unresolved', evidence.code);
  if (evidence.status !== 'qualified_candidate')
    return review('non_working_day');
  if (day.leave !== 'partial_or_pending') return review('leave_mode_mismatch');
  const work = parsed.halves.find((v) => v.kind === 'work'),
    leave = parsed.halves.find((v) => v.kind === 'leave');
  if (!work || !leave || !selected) return review('partition_invalid');
  if (!leave.approval || leave.approval.status !== 'approved')
    return review('approval_unresolved');
  const window = previewAttendanceScheduleWindow(selected);
  if (window.status !== 'schedule_window_candidate')
    return review('partition_invalid');
  const start = Date.parse(window.scheduledFrom),
    end = Date.parse(window.scheduledUntil);
  const halves = parsed.halves
    .map((v) => ({
      from: Date.parse(v.interval.from),
      until: Date.parse(v.interval.until),
    }))
    .sort((a, b) => a.from - b.from);
  if (
    halves[0].from !== start ||
    halves[0].until !== halves[1].from ||
    halves[1].until !== end
  )
    return review('partition_invalid');
  const breaks = parsed.breaks
    .map((v) => ({ from: Date.parse(v.from), until: Date.parse(v.until) }))
    .sort((a, b) => a.from - b.from);
  if (
    breaks.some(
      (v, i) =>
        v.from < start ||
        v.until > end ||
        (i > 0 && v.from < breaks[i - 1].until),
    ) ||
    breaks.reduce((total, v) => total + v.until - v.from, 0) !==
      selected.policy.settings.unpaidBreakMinutes * 60000
  )
    return review('partition_invalid');
  const breakWithin = (from: number, until: number) =>
    breaks.reduce(
      (total, b) => total + overlap(from, until, b.from, b.until),
      0,
    );
  // Bounded equal-net half-day plan only. Do not guess proportional thresholds
  // or break placement for unsupported custom partial schedules.
  if (
    halves.some(
      (h) =>
        h.until - h.from - breakWithin(h.from, h.until) !==
        selected.policy.settings.halfDayTargetMinutes * 60000,
    )
  )
    return review('partition_invalid');
  const workFrom = Date.parse(work.interval.from),
    workUntil = Date.parse(work.interval.until),
    leaveFrom = Date.parse(leave.interval.from),
    leaveUntil = Date.parse(leave.interval.until);
  const first =
      evidence.firstPunchAt === null ? null : Date.parse(evidence.firstPunchAt),
    last =
      evidence.lastPunchAt === null ? null : Date.parse(evidence.lastPunchAt);
  if (
    first !== null &&
    last !== null &&
    overlap(first, last, leaveFrom, leaveUntil) > 0
  )
    return review('work_leave_overlap');
  const gross = first === null || last === null ? 0 : last - first;
  const deducted =
    first === null || last === null ? 0 : breakWithin(first, last);
  const eligibleFrom = first === null ? workFrom : Math.max(first, workFrom),
    eligibleUntil = last === null ? workFrom : Math.min(last, workUntil);
  const eligibleGross = Math.max(0, eligibleUntil - eligibleFrom);
  const eligibleBreak = eligibleGross
    ? breakWithin(eligibleFrom, eligibleUntil)
    : 0;
  const worked = gross - deducted,
    eligible = eligibleGross - eligibleBreak;
  const qualification =
    first === null
      ? 'no_punch_work'
      : eligible >= selected.policy.settings.minimumHalfDayMinutes * 60000
        ? 'half_day_work'
        : 'insufficient_work';
  const workUnits = qualification === 'half_day_work' ? 0.5 : 0;
  const late = first === null ? 0 : Math.max(0, first - workFrom),
    early = last === null ? 0 : Math.max(0, workUntil - last);
  return attendanceLeaveCompositionPreviewSchema.parse({
    ...common,
    status: 'composed_candidate',
    qualification,
    workUnits,
    paidLeaveUnits: leave.approval.pay === 'paid' ? 0.5 : 0,
    unpaidLeaveUnits: leave.approval.pay === 'unpaid' ? 0.5 : 0,
    uncoveredAbsenceUnits: 0.5 - workUnits,
    leaveApprovalId: leave.approval.id,
    leaveApprovalVersion: leave.approval.version,
    workWindow: work.interval,
    leaveWindow: leave.interval,
    breakWindows: breaks.map((v) => ({
      from: new Date(v.from).toISOString(),
      until: new Date(v.until).toISOString(),
    })),
    firstPunchAt: evidence.firstPunchAt,
    lastPunchAt: evidence.lastPunchAt,
    coverageMappingId: evidence.coverageMappingId,
    coverageMappingVersion: evidence.coverageMappingVersion,
    punchReferences: evidence.punchReferences,
    plannedWorkMilliseconds:
      selected.policy.settings.halfDayTargetMinutes * 60000,
    grossWorkedMilliseconds: gross,
    breakDeductedMilliseconds: deducted,
    workedMilliseconds: worked,
    eligibleWorkedMilliseconds: eligible,
    workedMinutes: worked / 60000,
    eligibleWorkedMinutes: eligible / 60000,
    lateMilliseconds: late,
    earlyMilliseconds: early,
    isLate:
      first !== null &&
      late > selected.policy.settings.lateGraceMinutes * 60000,
    isEarly:
      last !== null &&
      early > selected.policy.settings.earlyGraceMinutes * 60000,
    overtimeCandidateMilliseconds: worked - eligible,
    overtimePayable: false,
  });
}
