import { z } from 'zod';
const id = z.uuid().toLowerCase();
const days = z.number().min(0).max(366).multipleOf(0.5);
const yearStart = z
  .strictObject({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .refine(
    (v) =>
      z.iso
        .date()
        .safeParse(
          `2001-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`,
        ).success,
    'Leave year start must exist every year',
  );
export const leavePolicySettingsSchema = z.strictObject({
  scope: z.literal('company'),
  timeZone: z.literal('Asia/Karachi'),
  code: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/),
  name: z.string().trim().min(1).max(120),
  pay: z.enum(['paid', 'unpaid']),
  grantMode: z.literal('annual_upfront'),
  annualQuotaDays: days,
  monthlyQuotaDays: days.max(31),
  leaveYearStart: yearStart,
  nonWorkingDays: z.enum(['exclude', 'include']),
});
export const leavePolicyDraftSchema = z.strictObject({
  expectedCurrentVersion: z.number().int().min(0).max(2147483646),
  effectiveFrom: z.iso.date(),
  settings: leavePolicySettingsSchema,
  reason: z.string().trim().min(3).max(240),
});
export const leavePublishedPolicySchema = z
  .strictObject({
    id,
    tenantId: id,
    leaveTypeId: id,
    version: z.number().int().positive().max(2147483647),
    status: z.literal('published'),
    effectiveFrom: z.iso.date(),
    effectiveUntil: z.iso.date().nullable(),
    settings: leavePolicySettingsSchema,
  })
  .refine(
    (v) => v.effectiveUntil === null || v.effectiveUntil > v.effectiveFrom,
    'Policy interval must be positive',
  );
const part = z.enum(['full_day', 'first_half', 'second_half']);
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
export const leaveQuotaRequestSchema = z.strictObject({
  tenantId: id,
  employeeId: id,
  leaveTypeId: id,
  requestId: id,
  expectedUsageVersion: z.number().int().min(0).max(2147483646),
  dates: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        part,
        calendar: z.enum([
          'working_day',
          'rest_day',
          'holiday',
          'not_employed',
          'unknown',
        ]),
        periodState: z.enum(['open', 'locked']),
      }),
    )
    .min(1)
    .max(366),
});
// Internal authoritative snapshots only; shapes/versions do not confer authority.
export const leaveUsageSnapshotSchema = z.strictObject({
  tenantId: id,
  employeeId: id,
  leaveTypeId: id,
  version: z.number().int().min(0).max(2147483646),
  leaveYearStart: yearStart,
  annual: z
    .array(
      z.strictObject({
        from: z.iso.date(),
        until: z.iso.date(),
        reservedDays: days,
        usedDays: days,
      }),
    )
    .max(3),
  monthly: z
    .array(
      z.strictObject({
        month,
        reservedDays: days.max(31),
        usedDays: days.max(31),
      }),
    )
    .max(24),
  occupied: z
    .array(z.strictObject({ requestId: id, date: z.iso.date(), part }))
    .max(1000),
});
export const leaveQuotaPreviewInputSchema = z.strictObject({
  policy: leavePublishedPolicySchema,
  request: leaveQuotaRequestSchema,
  usage: leaveUsageSnapshotSchema,
});
export const leaveQuotaReviewCodeSchema = z.enum([
  'LEAVE_USAGE_STALE',
  'LEAVE_USAGE_UNRESOLVED',
  'LEAVE_POLICY_CHANGE_REQUIRES_SPLIT',
  'LEAVE_YEAR_CHANGE_REQUIRES_RECONCILIATION',
  'LEAVE_INVALID_REQUEST',
  'LEAVE_PERIOD_LOCKED',
  'LEAVE_CALENDAR_UNRESOLVED',
  'LEAVE_NOT_EMPLOYED',
  'LEAVE_NO_CHARGEABLE_DATES',
  'LEAVE_OVERLAP',
]);
const bucket = {
  quotaDays: days,
  reservedDays: days,
  usedDays: days,
  requestedDays: days,
  availableBeforeDays: days,
  availableAfterDays: days,
};
export const leaveAnnualQuotaPlanSchema = z.strictObject({
  from: z.iso.date(),
  until: z.iso.date(),
  ...bucket,
});
export const leaveMonthlyQuotaPlanSchema = z.strictObject({ month, ...bucket });
const flags = {
  leaveReservationAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
const common = {
  tenantId: id,
  employeeId: id,
  leaveTypeId: id,
  requestId: id,
  policyId: id,
  policyVersion: z.number().int().positive(),
  ...flags,
};
export const leaveQuotaPreviewSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...common,
    status: z.literal('needs_review'),
    code: leaveQuotaReviewCodeSchema,
  }),
  z.strictObject({
    ...common,
    status: z.literal('quota_exceeded'),
    code: z.enum([
      'LEAVE_ANNUAL_QUOTA_EXCEEDED',
      'LEAVE_MONTHLY_QUOTA_EXCEEDED',
    ]),
    period: z.string(),
    quotaDays: days,
    reservedDays: days,
    usedDays: days,
    requestedDays: days,
    availableDays: days,
    overLimitDays: days,
  }),
  z
    .strictObject({
      ...common,
      status: z.literal('reservation_candidate'),
      expectedUsageVersion: z.number().int().nonnegative(),
      pay: z.enum(['paid', 'unpaid']),
      annual: leaveAnnualQuotaPlanSchema.array().min(1).max(3),
      monthly: leaveMonthlyQuotaPlanSchema.array().min(1).max(24),
      chargeableDates: z
        .array(
          z.strictObject({
            date: z.iso.date(),
            part,
            days: z.union([z.literal(0.5), z.literal(1)]),
          }),
        )
        .min(1)
        .max(366),
      excludedDates: z.iso.date().array().max(366),
      totalRequestedDays: days,
    })
    .superRefine((v, c) => {
      const total = v.chargeableDates.reduce((sum, d) => sum + d.days, 0);
      const bad = [...v.annual, ...v.monthly].some(
        (b) =>
          b.requestedDays <= 0 ||
          b.availableBeforeDays !==
            Math.max(0, b.quotaDays - b.reservedDays - b.usedDays) ||
          b.availableAfterDays !== b.availableBeforeDays - b.requestedDays ||
          b.availableAfterDays < 0,
      );
      if (
        bad ||
        total !== v.totalRequestedDays ||
        v.annual.reduce((sum, b) => sum + b.requestedDays, 0) !== total ||
        v.monthly.reduce((sum, b) => sum + b.requestedDays, 0) !== total ||
        v.chargeableDates.some(
          (d) => d.days !== (d.part === 'full_day' ? 1 : 0.5),
        ) ||
        new Set(v.chargeableDates.map((d) => d.date)).size !==
          v.chargeableDates.length
      )
        c.addIssue({
          code: 'custom',
          message: 'Inconsistent reservation plan',
        });
    }),
]);
export type LeaveQuotaPreview = z.infer<typeof leaveQuotaPreviewSchema>;
export type LeaveQuotaReviewCode = z.infer<typeof leaveQuotaReviewCodeSchema>;
