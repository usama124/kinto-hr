import {
  attendanceSourceEventSchema,
  attendanceNormalizationContextSchema,
  attendanceNormalizedPreviewSchema,
  attendanceScheduleCandidatesSchema,
  type AttendanceNormalizedPreview,
} from '@kinto/contracts';
import { previewAttendanceTiming } from './attendance-timing';

const offsetMilliseconds = 300 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
// This slice supports the +05:00 candidate only. Verify against the actual IANA
// date; historical offsets that do not match are reviewed, never silently shifted.
function localInstant(local: string): number | null {
  const wall = Date.parse(local + 'Z');
  if (!Number.isFinite(wall)) return null;
  const utc = wall - offsetMilliseconds;
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(utc)).map((v) => [v.type, v.value]),
  );
  const roundtrip = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  if (roundtrip !== local.slice(0, 19)) return null;
  // Refuse dates near an offset transition too: a repeated wall time could
  // otherwise round-trip for +05:00 while also representing another instant.
  // Historical transition handling requires its own reviewed implementation.
  for (const delta of [-36 * 3600000, 36 * 3600000]) {
    const probe = utc + delta;
    const actual = Object.fromEntries(
      formatter.formatToParts(new Date(probe)).map((v) => [v.type, v.value]),
    );
    const wallAtProbe = `${actual.year}-${actual.month}-${actual.day}T${actual.hour}:${actual.minute}:${actual.second}`;
    if (
      wallAtProbe !==
      new Date(probe + offsetMilliseconds).toISOString().slice(0, 19)
    )
      return null;
  }
  return utc;
}
export function previewAttendanceNormalization(
  sourceInput: unknown,
  contextInput: unknown,
): AttendanceNormalizedPreview {
  const source = attendanceSourceEventSchema.parse(sourceInput),
    context = attendanceNormalizationContextSchema.parse(contextInput);
  const reviewCodes: Extract<
    AttendanceNormalizedPreview,
    { status: 'needs_review' }
  >['reviewCodes'] = [];
  if (context.sourceIdentity !== 'verified')
    reviewCodes.push('source_identity_unverified');
  if (context.clock.status !== 'verified') reviewCodes.push('clock_unverified');
  const occurredAt = localInstant(source.sourceLocalTimestamp);
  if (occurredAt === null) reviewCodes.push('unsupported_timezone_offset');
  if (context.clock.status === 'verified') {
    if (
      Math.abs(context.clock.observedDriftMilliseconds) >
      context.clock.maximumAbsoluteDriftMilliseconds
    )
      reviewCodes.push('clock_suspect');
    if (
      occurredAt !== null &&
      occurredAt - Date.parse(context.receivedAt) >
        context.clock.maximumFutureLeadMilliseconds
    )
      reviewCodes.push('event_in_future');
  }
  const common = {
    tenantId: context.tenantId,
    deviceId: context.deviceId,
    timeZone: context.timeZone,
    receivedAt: context.receivedAt,
    source,
    attendanceProcessingAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
  return attendanceNormalizedPreviewSchema.parse(
    reviewCodes.length
      ? { ...common, status: 'needs_review', occurredAt: null, reviewCodes }
      : {
          ...common,
          status: 'candidate',
          occurredAt: new Date(occurredAt!).toISOString(),
          reviewCodes: [],
        },
  );
}

// Pure what-if association only. Inputs are independent trusted schedule snapshots;
// this does not resolve employee mapping, calendar/leave, latest policy or locked periods.
export function previewAttendanceAssociation(
  normalizedInput: unknown,
  schedulesInput: unknown,
) {
  const normalized = attendanceNormalizedPreviewSchema.parse(normalizedInput),
    schedules = attendanceScheduleCandidatesSchema.parse(schedulesInput);
  const flags = {
    attendanceProcessingAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
  if (
    schedules.some(
      (v) =>
        v.tenantId !== normalized.tenantId ||
        v.deviceId !== normalized.deviceId,
    )
  )
    throw new Error('ATTENDANCE_SCOPE_MISMATCH');
  const dates = new Set<string>();
  const windows = schedules.map((schedule) => {
    if (
      dates.has(schedule.workDate) ||
      schedule.policy.effectiveFrom > schedule.workDate
    )
      throw new Error('INVALID_ATTENDANCE_SCHEDULE');
    dates.add(schedule.workDate);
    const midnight = localInstant(schedule.workDate + 'T00:00:00');
    const preview = previewAttendanceTiming(schedule.policy.settings);
    if (midnight === null) return null;
    const from = midnight + preview.associationWindow.fromLocalMinute * 60000;
    const until = midnight + preview.associationWindow.untilLocalMinute * 60000;
    // Refuse a historical offset transition across the window rather than treat
    // a variable-offset day as fixed-offset minute arithmetic.
    for (const at of [from, until]) {
      const local = new Date(at + offsetMilliseconds)
        .toISOString()
        .slice(0, 19);
      if (localInstant(local) !== at) return null;
    }
    return { schedule, from, until };
  });
  if (normalized.status !== 'candidate')
    return {
      status: 'needs_review' as const,
      code: 'normalization_unverified' as const,
      ...flags,
    };
  const occurredAt = Date.parse(normalized.occurredAt);
  if (localInstant(normalized.source.sourceLocalTimestamp) !== occurredAt)
    throw new Error('INVALID_ATTENDANCE_INSTANT');
  if (windows.some((v) => v === null))
    return {
      status: 'needs_review' as const,
      code: 'unsupported_timezone_offset' as const,
      ...flags,
    };
  const matches = windows.filter(
    (v) => v !== null && occurredAt >= v.from && occurredAt < v.until,
  );
  if (matches.length > 1)
    return {
      status: 'needs_review' as const,
      code: 'ambiguous_schedule' as const,
      ...flags,
    };
  if (!matches.length) return { status: 'outside_window' as const, ...flags };
  const matched = matches[0]!;
  return {
    status: 'schedule_candidate' as const,
    tenantId: normalized.tenantId,
    deviceId: normalized.deviceId,
    connectorEventId: normalized.source.connectorEventId,
    occurredAt: normalized.occurredAt,
    workDate: matched.schedule.workDate,
    policyId: matched.schedule.policy.id,
    policyVersion: matched.schedule.policy.version,
    policyEffectiveFrom: matched.schedule.policy.effectiveFrom,
    dayAnchor: 'scheduled_check_in_local_date' as const,
    associationWindow: {
      from: new Date(matched.from).toISOString(),
      until: new Date(matched.until).toISOString(),
      endExclusive: true as const,
    },
    ...flags,
  };
}
