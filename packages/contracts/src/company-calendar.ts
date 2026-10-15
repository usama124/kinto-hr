import { z } from 'zod';
import {
  attendanceTimingMutationSchema,
  attendanceTimingPublishSchema,
} from './attendance-timing';
const id = z.uuid().toLowerCase();
const date = z.iso.date().refine((v) => v >= '0001-01-01' && v < '9999-12-31');
const utc = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
export const companyCalendarSettingsSchema = z
  .strictObject({
    scope: z.literal('company'),
    timeZone: z.literal('Asia/Karachi'),
    // Inclusive reviewed coverage; dates beyond this must not imply workdays.
    coverageUntil: date,
    holidays: z
      .strictObject({ date, name: z.string().trim().min(1).max(120) })
      .array()
      .max(366),
  })
  .refine(
    (v) => new Set(v.holidays.map((h) => h.date)).size === v.holidays.length,
    { message: 'Duplicate holiday dates' },
  );
function validWindow(v: {
  effectiveFrom: string;
  settings: z.infer<typeof companyCalendarSettingsSchema>;
}) {
  return (
    v.settings.coverageUntil >= v.effectiveFrom &&
    Date.parse(v.settings.coverageUntil + 'T00:00:00Z') -
      Date.parse(v.effectiveFrom + 'T00:00:00Z') <=
      365 * 86400000 &&
    v.settings.holidays.every(
      (h) => h.date >= v.effectiveFrom && h.date <= v.settings.coverageUntil,
    )
  );
}
export const companyCalendarPolicyDraftSchema = z
  .strictObject({
    expectedCurrentVersion: z.number().int().min(0).max(2147483646),
    effectiveFrom: date,
    settings: companyCalendarSettingsSchema,
    reason: z.string().trim().min(3).max(240),
  })
  .refine(validWindow, {
    message: 'Review a complete calendar window of at most 366 dates',
  });
export const companyCalendarPublishSchema = attendanceTimingPublishSchema;
export const companyCalendarMutationSchema = attendanceTimingMutationSchema;
export const companyCalendarQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  afterId: id.optional(),
  asOf: date.optional(),
});
export const companyCalendarPolicySchema = z
  .strictObject({
    id,
    version: z.number().int().min(1).max(2147483647),
    basedOnVersion: z.number().int().nonnegative(),
    status: z.enum(['draft', 'published']),
    effectiveFrom: date,
    effectiveUntil: z.iso.date().nullable(),
    settings: companyCalendarSettingsSchema,
    reason: z.string().min(3).max(240),
    createdAt: utc,
    publishedAt: utc.nullable(),
  })
  .refine(
    (v) =>
      validWindow(v) &&
      v.basedOnVersion < v.version &&
      (v.status === 'published') === (v.publishedAt !== null) &&
      (v.status === 'draft'
        ? v.effectiveUntil === null
        : v.effectiveUntil !== null &&
          v.effectiveUntil > v.effectiveFrom &&
          v.effectiveUntil <=
            new Date(
              Date.parse(v.settings.coverageUntil + 'T00:00:00Z') + 86400000,
            )
              .toISOString()
              .slice(0, 10)),
  );
const flags = {
  leaveReservationAvailable: z.literal(false),
  attendanceProcessingAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
export const companyCalendarListSchema = z.strictObject({
  tenantId: id,
  asOf: date,
  latestPublishedVersion: z.number().int().nonnegative(),
  currentPolicy: companyCalendarPolicySchema.nullable(),
  items: companyCalendarPolicySchema.array().max(50),
  nextCursor: id.nullable(),
  ...flags,
});
export const companyCalendarDaysQuerySchema = z
  .strictObject({ from: date, until: date })
  .refine(
    (v) =>
      v.until >= v.from &&
      Date.parse(v.until + 'T00:00:00Z') - Date.parse(v.from + 'T00:00:00Z') <=
        365 * 86400000,
  );
const ref = z.strictObject({ id, version: z.number().int().positive() });
const day = z.discriminatedUnion('calendar', [
  z
    .strictObject({
      date,
      calendar: z.literal('unknown'),
      code: z.enum(['CALENDAR_UNRESOLVED', 'TIMING_UNRESOLVED']),
      calendarPolicy: ref.nullable(),
      timingPolicy: ref.nullable(),
    })
    .refine((v) =>
      v.code === 'CALENDAR_UNRESOLVED'
        ? v.calendarPolicy === null
        : v.calendarPolicy !== null && v.timingPolicy === null,
    ),
  z
    .strictObject({
      date,
      calendar: z.enum(['working_day', 'rest_day', 'holiday']),
      holidayName: z.string().min(1).max(120).nullable(),
      calendarPolicy: ref,
      timingPolicy: ref,
    })
    .refine((v) => (v.calendar === 'holiday') === (v.holidayName !== null)),
]);
export const companyCalendarDaysSchema = z.strictObject({
  tenantId: id,
  from: date,
  until: date,
  days: day.array().min(1).max(366),
  ...flags,
});
