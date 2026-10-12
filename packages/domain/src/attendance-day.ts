import {
  attendanceDayPreviewInputSchema,
  attendanceDayPreviewSchema,
  type AttendanceDayReviewCode,
  type AttendanceDayPreview,
} from '@kinto/contracts';
import {
  previewAttendanceAssociation,
  previewAttendanceScheduleWindow,
} from './attendance-normalization';
import { previewAttendanceTiming } from './attendance-timing';

// No source promotion, leave settlement, payable overtime or salary deduction.
// All context/evidence must be independently resolved by future trusted services.
export function previewAttendanceDay(input: unknown): AttendanceDayPreview {
  const day = attendanceDayPreviewInputSchema.parse(input);
  if (
    day.coverageMapping &&
    (day.coverageMapping.deviceId !== day.deviceId ||
      day.coverageMapping.employeeId !== day.employeeId)
  )
    throw new Error('ATTENDANCE_SCOPE_MISMATCH');
  const selected = day.schedules.find((v) => v.workDate === day.workDate);
  const dates = new Set<string>();
  for (const schedule of day.schedules) {
    if (
      schedule.tenantId !== day.tenantId ||
      schedule.deviceId !== day.deviceId
    )
      throw new Error('ATTENDANCE_SCOPE_MISMATCH');
    if (
      dates.has(schedule.workDate) ||
      schedule.policy.effectiveFrom > schedule.workDate
    )
      throw new Error('INVALID_ATTENDANCE_SCHEDULE');
    dates.add(schedule.workDate);
  }
  for (const punch of day.punches) {
    if (
      punch.normalized.tenantId !== day.tenantId ||
      punch.normalized.deviceId !== day.deviceId ||
      (punch.mapping &&
        (punch.mapping.employeeId !== day.employeeId ||
          punch.mapping.deviceId !== day.deviceId))
    )
      throw new Error('ATTENDANCE_SCOPE_MISMATCH');
  }
  const common = {
    tenantId: day.tenantId,
    deviceId: day.deviceId,
    employeeId: day.employeeId,
    workDate: day.workDate,
    calculationVersion: 1 as const,
    policyId: selected?.policy.id ?? null,
    policyVersion: selected?.policy.version ?? null,
    coverageMappingId: day.coverageMapping?.id ?? null,
    coverageMappingVersion: day.coverageMapping?.version ?? null,
    attendanceProcessingAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
  const review = (code: AttendanceDayReviewCode) =>
    attendanceDayPreviewSchema.parse({
      ...common,
      status: 'needs_review',
      code,
      uncoveredAbsenceUnits: null,
      workedMinutes: null,
    });
  const exempt = (status: 'not_employed' | 'holiday' | 'rest_day' | 'leave') =>
    attendanceDayPreviewSchema.parse({
      ...common,
      status,
      uncoveredAbsenceUnits: null,
      workedMinutes: null,
    });
  if (day.periodState === 'locked') return review('locked_period');
  if (day.employment === 'unknown') return review('employment_unknown');
  if (day.employment === 'not_employed')
    return day.punches.length
      ? review('non_workday_punches')
      : exempt('not_employed');
  if (day.calendar === 'unknown') return review('calendar_unknown');
  if (day.calendar !== 'working_day')
    return day.punches.length
      ? review('non_workday_punches')
      : exempt(day.calendar);
  if (day.leave === 'partial_or_pending')
    return review('leave_composition_required');
  if (day.leave === 'approved_full_day')
    return day.punches.length ? review('non_workday_punches') : exempt('leave');
  if (!selected) return review('unknown_schedule');
  const settings = selected.policy.settings,
    schedulePreview = previewAttendanceTiming(settings);
  const weekday = new Date(day.workDate + 'T00:00:00Z').getUTCDay() || 7;
  if (settings.weeklyRestDays.includes(weekday))
    return review('calendar_policy_conflict');
  if (day.evidence !== 'complete_closed') return review('incomplete_evidence');

  const window = previewAttendanceScheduleWindow(selected);
  if (window.status !== 'schedule_window_candidate')
    return review('association_unresolved');

  const unique = new Map<
    string,
    {
      at: number;
      normalized: (typeof day.punches)[number]['normalized'];
      mapping: NonNullable<(typeof day.punches)[number]['mapping']>;
      signature: string;
    }
  >();
  const sourceIds = new Set<string>();
  for (const punch of day.punches) {
    const normalized = punch.normalized,
      mapping = punch.mapping;
    if (normalized.status !== 'candidate')
      return review('normalization_unverified');
    if (!mapping) return review('mapping_unresolved');
    if (mapping.sourceUserId !== normalized.source.sourceUserId)
      return review('mapping_source_mismatch');
    const at = Date.parse(normalized.occurredAt);
    if (
      at < Date.parse(mapping.effectiveFrom) ||
      (mapping.effectiveUntil !== null &&
        at >= Date.parse(mapping.effectiveUntil))
    )
      return review('mapping_outside_interval');
    const association = previewAttendanceAssociation(normalized, day.schedules);
    if (association.status === 'needs_review')
      return review('association_unresolved');
    if (association.status === 'outside_window')
      return review('outside_window');
    if (association.workDate !== day.workDate) return review('wrong_workdate');
    const signature = JSON.stringify({
      source: normalized.source,
      occurredAt: normalized.occurredAt,
      mappingId: mapping.id,
      mappingVersion: mapping.version,
      effectiveFrom: mapping.effectiveFrom,
      effectiveUntil: mapping.effectiveUntil,
    });
    const prior = unique.get(normalized.source.connectorEventId);
    if (prior) {
      if (prior.signature !== signature) return review('conflicting_duplicate');
      continue;
    }
    // Vendor IDs without a verified reset epoch cannot safely be deduplicated
    // across distinct transport IDs. Review rather than merge guessed identity.
    if (normalized.source.sourceEventId) {
      const sourceId =
        normalized.source.sourceUserId + ':' + normalized.source.sourceEventId;
      if (sourceIds.has(sourceId)) return review('source_identity_conflict');
      sourceIds.add(sourceId);
    }
    unique.set(normalized.source.connectorEventId, {
      at,
      normalized,
      mapping,
      signature,
    });
  }
  const ordered = [...unique.values()].sort(
    (a, b) =>
      a.at - b.at ||
      a.normalized.source.connectorEventId.localeCompare(
        b.normalized.source.connectorEventId,
      ),
  );
  if (!ordered.length) {
    if (!day.coverageMapping) return review('mapping_unresolved');
    if (
      Date.parse(day.coverageMapping.effectiveFrom) >
        Date.parse(window.scheduledFrom) ||
      (day.coverageMapping.effectiveUntil !== null &&
        Date.parse(day.coverageMapping.effectiveUntil) <=
          Date.parse(window.scheduledUntil))
    )
      return review('mapping_outside_interval');
  }
  if (ordered.length === 1) return review('missing_punch');
  if (ordered.some((v, i) => i > 0 && v.at === ordered[i - 1].at))
    return review('ambiguous_punches');
  if (ordered.length) {
    if (day.punchRule === 'verified_in_out') {
      // Fixed-duration break mode does not also infer explicit break pairs.
      if (
        ordered.length !== 2 ||
        ordered[0].normalized.source.direction !== 'in' ||
        ordered[1].normalized.source.direction !== 'out'
      )
        return review('ambiguous_punches');
    } else if (ordered.some((v) => v.normalized.source.direction !== undefined))
      return review('direction_rule_mismatch');
  }
  const start = Date.parse(window.scheduledFrom),
    end = Date.parse(window.scheduledUntil);
  const first = ordered[0]?.at ?? null,
    last = ordered.at(-1)?.at ?? null;
  const gross = first === null || last === null ? 0 : last - first;
  const eligibleGross =
    first === null || last === null
      ? 0
      : Math.max(0, Math.min(last, end) - Math.max(first, start));
  const configuredBreak = settings.unpaidBreakMinutes * 60000;
  const breakDeducted = Math.min(configuredBreak, gross),
    eligibleBreak = Math.min(configuredBreak, eligibleGross);
  const worked = gross - breakDeducted,
    eligible = eligibleGross - eligibleBreak;
  const qualification = !ordered.length
    ? 'no_punch_absence'
    : eligible >= settings.minimumFullDayMinutes * 60000
      ? 'full_day'
      : eligible >= settings.minimumHalfDayMinutes * 60000
        ? 'half_day'
        : 'insufficient';
  const late = first === null ? 0 : Math.max(0, first - start),
    early = last === null ? 0 : Math.max(0, end - last);
  return attendanceDayPreviewSchema.parse({
    ...common,
    status: 'qualified_candidate',
    qualification,
    uncoveredAbsenceUnits:
      qualification === 'full_day' ? 0 : qualification === 'half_day' ? 0.5 : 1,
    firstPunchAt: first === null ? null : new Date(first).toISOString(),
    lastPunchAt: last === null ? null : new Date(last).toISOString(),
    uniquePunchCount: ordered.length,
    punchReferences: ordered.map((v) => ({
      connectorEventId: v.normalized.source.connectorEventId,
      mappingId: v.mapping.id,
      mappingVersion: v.mapping.version,
    })),
    scheduledMinutes: schedulePreview.scheduledMinutes,
    netScheduledMinutes: schedulePreview.netScheduledMinutes,
    grossWorkedMilliseconds: gross,
    breakDeductedMilliseconds: breakDeducted,
    eligibleBreakDeductedMilliseconds: eligibleBreak,
    workedMilliseconds: worked,
    eligibleWorkedMilliseconds: eligible,
    workedMinutes: worked / 60000,
    eligibleWorkedMinutes: eligible / 60000,
    lateMilliseconds: late,
    earlyMilliseconds: early,
    isLate: first !== null && late > settings.lateGraceMinutes * 60000,
    isEarly: last !== null && early > settings.earlyGraceMinutes * 60000,
    overtimeCandidateMilliseconds: Math.max(0, worked - eligible),
    overtimePayable: false,
  });
}
