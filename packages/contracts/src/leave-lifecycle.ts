import { z } from 'zod';
import { leavePolicySettingsSchema } from './leave-quota';

const id = z.uuid().toLowerCase();
const version = z.number().int().min(1).max(2147483647);
const date = z.iso.date().refine((v) => v >= '0001-01-01');
const part = z.enum(['full_day', 'first_half', 'second_half']);

// Internal planning snapshots, never a public command/authorization contract.
// Persistence must independently resolve identity, routing, allocation and locks.
export const leaveRequestSnapshotSchema = z
  .strictObject({
    tenantId: id,
    employeeId: id,
    employeeIdentityId: id,
    submittedBy: id,
    leaveTypeId: id,
    requestId: id,
    policyId: id,
    policyVersion: version,
    version,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    pay: z.enum(['paid', 'unpaid']),
    leaveYearStart: leavePolicySettingsSchema.shape.leaveYearStart,
    dates: z
      .strictObject({ date, part, chargeable: z.boolean() })
      .array()
      .min(1)
      .max(366),
  })
  .superRefine((v, c) => {
    const dates = v.dates.map((d) => d.date).sort();
    if (
      new Set(dates).size !== dates.length ||
      !v.dates.some((d) => d.chargeable) ||
      Date.parse(`${dates.at(-1)}T00:00:00Z`) -
        Date.parse(`${dates[0]}T00:00:00Z`) >
        365 * 86400000
    )
      c.addIssue({ code: 'custom', message: 'Invalid request allocation' });
  });

export const leaveDecisionCommandSchema = z.strictObject({
  tenantId: id,
  employeeId: id,
  requestId: id,
  actorId: id,
  expectedVersion: version,
  expectedRoutingVersion: version,
  action: z.enum(['approve', 'reject', 'cancel']),
});

export const leaveDecisionContextSchema = z
  .strictObject({
    tenantId: id,
    employeeId: id,
    routingVersion: version,
    // Already resolved effective/eligible manager, not an arbitrary UI choice.
    eligibleManagerId: id.nullable(),
    eligibleHrIds: id.array().max(250),
    periods: z
      .strictObject({ date, state: z.enum(['open', 'locked', 'unknown']) })
      .array()
      .max(366),
  })
  .superRefine((v, c) => {
    if (
      new Set(v.eligibleHrIds).size !== v.eligibleHrIds.length ||
      new Set(v.periods.map((p) => p.date)).size !== v.periods.length
    )
      c.addIssue({ code: 'custom', message: 'Ambiguous decision context' });
  });

export const leaveLifecycleInputSchema = z.strictObject({
  request: leaveRequestSnapshotSchema,
  command: leaveDecisionCommandSchema,
  context: leaveDecisionContextSchema,
});

const flags = {
  leaveReservationAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
export const leaveLifecycleReviewCodeSchema = z.enum([
  'LEAVE_DECISION_FORBIDDEN',
  'LEAVE_REQUEST_STALE',
  'LEAVE_ROUTING_STALE',
  'LEAVE_INVALID_TRANSITION',
  'LEAVE_APPROVED_REVERSAL_REQUIRED',
  'LEAVE_PERIOD_LOCKED',
  'LEAVE_PERIOD_UNRESOLVED',
  'LEAVE_VERSION_EXHAUSTED',
  'LEAVE_ALLOCATION_UNRESOLVED',
]);
const scope = {
  tenantId: id,
  employeeId: id,
  leaveTypeId: id,
  requestId: id,
  actorId: id,
  ...flags,
};
const counts = {
  reservedHalfUnits: z.number().int().min(-732).max(-1),
  usedHalfUnits: z.number().int().min(0).max(732),
};
const delta = z
  .discriminatedUnion('bucket', [
    z.strictObject({ bucket: z.literal('annual'), period: date, ...counts }),
    z.strictObject({
      bucket: z.literal('monthly'),
      period: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .refine((v) => v >= '0001-01'),
      ...counts,
      reservedHalfUnits: counts.reservedHalfUnits.min(-62),
      usedHalfUnits: counts.usedHalfUnits.max(62),
    }),
  ])
  .refine(
    (v) => v.usedHalfUnits === 0 || v.usedHalfUnits === -v.reservedHalfUnits,
  );
export const leaveLifecyclePreviewSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...scope,
    status: z.literal('needs_review'),
    code: leaveLifecycleReviewCodeSchema,
  }),
  z
    .strictObject({
      ...scope,
      status: z.literal('transition_candidate'),
      expectedVersion: version,
      nextVersion: version,
      expectedRoutingVersion: version,
      nextStatus: z.enum(['approved', 'rejected', 'cancelled']),
      policyId: id,
      policyVersion: version,
      pay: z.enum(['paid', 'unpaid']),
      occupancy: z.enum(['retain', 'release']),
      deltas: delta.array().min(2).max(27),
    })
    .superRefine((v, c) => {
      const annual = v.deltas.filter((d) => d.bucket === 'annual');
      const monthly = v.deltas.filter((d) => d.bucket === 'monthly');
      if (
        v.nextVersion !== v.expectedVersion + 1 ||
        v.occupancy !== (v.nextStatus === 'approved' ? 'retain' : 'release') ||
        !annual.length ||
        !monthly.length ||
        annual.length > 3 ||
        monthly.length > 24 ||
        annual.reduce((n, d) => n - d.reservedHalfUnits, 0) > 732 ||
        new Set(v.deltas.map((d) => `${d.bucket}:${d.period}`)).size !==
          v.deltas.length ||
        annual.reduce((n, d) => n + d.reservedHalfUnits, 0) !==
          monthly.reduce((n, d) => n + d.reservedHalfUnits, 0) ||
        v.deltas.some(
          (d) =>
            d.usedHalfUnits !==
            (v.nextStatus === 'approved' ? -d.reservedHalfUnits : 0),
        )
      )
        c.addIssue({ code: 'custom', message: 'Inconsistent transition plan' });
    }),
]);
export type LeaveLifecyclePreview = z.infer<typeof leaveLifecyclePreviewSchema>;
export type LeaveLifecycleReviewCode = z.infer<
  typeof leaveLifecycleReviewCodeSchema
>;
