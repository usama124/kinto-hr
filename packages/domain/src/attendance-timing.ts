import { attendanceTimingSettingsSchema } from '@kinto/contracts';

// Pure policy preview only. Offsets are local minutes, never normalized punch UTC.
// No company version is published, employee qualified, absence charged or pay changed.
export function previewAttendanceTiming(input: unknown) {
  const settings = attendanceTimingSettingsSchema.parse(input);
  const minutes = (time: string) =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = minutes(settings.checkIn);
  const end =
    minutes(settings.checkOut) + (settings.checkOutNextDay ? 1440 : 0);
  return {
    settings: {
      ...settings,
      weeklyRestDays: [...settings.weeklyRestDays].sort((a, b) => a - b),
    },
    dayAnchor: 'scheduled_check_in_local_date' as const,
    scheduledMinutes: end - start,
    netScheduledMinutes: end - start - settings.unpaidBreakMinutes,
    // Half-open local-minute interval relative to the scheduled check-in date.
    associationWindow: {
      fromLocalMinute: start - settings.associationBeforeMinutes,
      untilLocalMinute: end + settings.associationAfterMinutes,
      endExclusive: true as const,
    },
    attendanceProcessingAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
}
