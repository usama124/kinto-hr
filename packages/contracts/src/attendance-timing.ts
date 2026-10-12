import { z } from 'zod';

const minute = z.number().int().min(0).max(1439);
const positiveMinutes = minute.min(1);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const asMinutes = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// Explicit employer settings only: no statutory defaults or punch-derived values.
export const attendanceTimingSettingsSchema = z
  .strictObject({
    scope: z.literal('company'),
    timeZone: z.literal('Asia/Karachi'),
    checkIn: localTime,
    checkOut: localTime,
    checkOutNextDay: z.boolean(),
    breakMode: z.literal('fixed_duration'),
    unpaidBreakMinutes: minute,
    fullDayTargetMinutes: positiveMinutes,
    halfDayTargetMinutes: positiveMinutes,
    minimumFullDayMinutes: positiveMinutes,
    minimumHalfDayMinutes: positiveMinutes,
    lateGraceMinutes: minute,
    earlyGraceMinutes: minute,
    associationBeforeMinutes: minute,
    associationAfterMinutes: minute,
    // ISO weekdays: Monday=1, Sunday=7. Empty means no configured weekly rest day.
    weeklyRestDays: z.array(z.number().int().min(1).max(7)).max(6),
  })
  .superRefine((settings, context) => {
    // Base schemas report malformed times; do not derive arithmetic from them.
    if (
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.checkIn) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.checkOut)
    )
      return;
    const duration =
      asMinutes(settings.checkOut) +
      (settings.checkOutNextDay ? 1440 : 0) -
      asMinutes(settings.checkIn);
    const fail = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (duration <= 0 || duration >= 1440)
      fail(
        'checkOutNextDay',
        'Choose an unambiguous positive shift shorter than 24 hours',
      );
    const net = duration - settings.unpaidBreakMinutes;
    if (net <= 0)
      fail(
        'unpaidBreakMinutes',
        'Break must be shorter than the scheduled shift',
      );
    if (settings.fullDayTargetMinutes > net)
      fail(
        'fullDayTargetMinutes',
        'Full-day target exceeds the net scheduled shift',
      );
    if (settings.halfDayTargetMinutes >= settings.fullDayTargetMinutes)
      fail(
        'halfDayTargetMinutes',
        'Half-day target must be below the full-day target',
      );
    if (settings.minimumFullDayMinutes > settings.fullDayTargetMinutes)
      fail('minimumFullDayMinutes', 'Full-day minimum exceeds its target');
    if (
      settings.minimumHalfDayMinutes >= settings.minimumFullDayMinutes ||
      settings.minimumHalfDayMinutes > settings.halfDayTargetMinutes
    )
      fail(
        'minimumHalfDayMinutes',
        'Half-day minimum must be below the full-day minimum and not exceed its target',
      );
    if (settings.lateGraceMinutes > net)
      fail('lateGraceMinutes', 'Grace cannot exceed net scheduled minutes');
    if (settings.earlyGraceMinutes > net)
      fail('earlyGraceMinutes', 'Grace cannot exceed net scheduled minutes');
    if (
      settings.associationBeforeMinutes +
        duration +
        settings.associationAfterMinutes >
      1440
    )
      fail(
        'associationAfterMinutes',
        'Daily punch-association windows cannot overlap',
      );
    if (
      new Set(settings.weeklyRestDays).size !== settings.weeklyRestDays.length
    )
      fail('weeklyRestDays', 'Weekly rest days must be unique');
  });
export const attendanceTimingPolicyDraftSchema = z.strictObject({
  expectedCurrentVersion: z.number().int().min(0).max(2147483646),
  effectiveFrom: z.iso.date(),
  settings: attendanceTimingSettingsSchema,
  reason: z.string().trim().min(3).max(240),
});
export type AttendanceTimingSettings = z.infer<
  typeof attendanceTimingSettingsSchema
>;
export type AttendanceTimingPolicyDraft = z.infer<
  typeof attendanceTimingPolicyDraftSchema
>;

const policyId = z.uuid().toLowerCase();
const utc = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
export const attendanceTimingPublishSchema = z.strictObject({
  expectedVersion: z.number().int().positive().max(2147483647),
  reason: z.string().trim().min(3).max(240),
});
export const attendanceTimingQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  afterId: policyId.optional(),
  asOf: z.iso.date().optional(),
});
export const attendanceTimingPolicySchema = z
  .strictObject({
    id: policyId,
    version: z.number().int().positive(),
    basedOnVersion: z.number().int().nonnegative(),
    status: z.enum(['draft', 'published']),
    effectiveFrom: z.iso.date(),
    settings: attendanceTimingSettingsSchema,
    reason: z.string().min(3).max(240),
    createdAt: utc,
    publishedAt: utc.nullable(),
  })
  .superRefine((v, c) => {
    if (
      v.basedOnVersion >= v.version ||
      (v.status === 'published') !== (v.publishedAt !== null)
    )
      c.addIssue({
        code: 'custom',
        message: 'Invalid policy version/publication state',
      });
  });
export const attendanceTimingListSchema = z.strictObject({
  tenantId: policyId,
  asOf: z.iso.date(),
  latestPublishedVersion: z.number().int().nonnegative(),
  currentPolicy: attendanceTimingPolicySchema.nullable(),
  items: attendanceTimingPolicySchema.array().max(50),
  nextCursor: policyId.nullable(),
  attendanceProcessingAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
});
export const attendanceTimingMutationSchema = z.strictObject({
  id: policyId,
  version: z.number().int().positive(),
  replayed: z.boolean(),
});
export type AttendanceTimingQuery = z.infer<typeof attendanceTimingQuerySchema>;
export type AttendanceTimingPublish = z.infer<
  typeof attendanceTimingPublishSchema
>;
export const attendanceTimingPreviewSchema = z.strictObject({
  tenantId: policyId,
  policy: attendanceTimingPolicySchema,
  dayAnchor: z.literal('scheduled_check_in_local_date'),
  scheduledMinutes: z.number().int().min(1).max(1439),
  netScheduledMinutes: z.number().int().min(1).max(1439),
  associationWindow: z.strictObject({
    fromLocalMinute: z.number().int().min(-1439).max(1439),
    untilLocalMinute: z.number().int().min(1).max(2878),
    endExclusive: z.literal(true),
  }),
  attendanceProcessingAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
});
