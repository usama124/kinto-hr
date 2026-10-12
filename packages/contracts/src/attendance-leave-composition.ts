import { z } from 'zod';
import {
  attendanceDayPreviewInputSchema,
  attendanceDayReviewCodeSchema,
} from './attendance-day';
const id = z.uuid().toLowerCase();
const instant = z.iso
  .datetime({ offset: true })
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
  )
  .transform((v) => new Date(v).toISOString());
export const attendanceCompositionIntervalSchema = z
  .strictObject({ from: instant, until: instant })
  .refine(
    (v) =>
      Date.parse(v.until) > Date.parse(v.from) &&
      Date.parse(v.from) % 60000 === 0 &&
      Date.parse(v.until) % 60000 === 0,
    'Plan intervals must be positive and aligned to minutes',
  );
const approval = z.strictObject({
  id,
  version: z.number().int().positive(),
  tenantId: id,
  employeeId: id,
  workDate: z.iso.date(),
  status: z.enum(['approved', 'pending', 'rejected', 'cancelled']),
  pay: z.enum(['paid', 'unpaid']),
});
const half = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('work'),
    interval: attendanceCompositionIntervalSchema,
  }),
  z.strictObject({
    kind: z.literal('leave'),
    interval: attendanceCompositionIntervalSchema,
    approval: approval.nullable(),
  }),
]);
// Synthetic/trusted company plan and approval snapshots, never upload authority.
export const attendanceLeaveCompositionInputSchema = z.strictObject({
  day: attendanceDayPreviewInputSchema,
  halves: z.tuple([half, half]),
  breaks: attendanceCompositionIntervalSchema.array().max(2),
});
const units = z.union([z.literal(0), z.literal(0.5)]);
const ms = z.number().int().min(0).max(86400000);
const common = {
  tenantId: id,
  deviceId: id,
  employeeId: id,
  workDate: z.iso.date(),
  calculationVersion: z.literal(1),
  policyId: id.nullable(),
  policyVersion: z.number().int().positive().nullable(),
  attendanceProcessingAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
export const attendanceLeaveCompositionPreviewSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      ...common,
      status: z.literal('needs_review'),
      code: z.enum([
        'attendance_unresolved',
        'non_working_day',
        'leave_mode_mismatch',
        'partition_invalid',
        'approval_unresolved',
        'work_leave_overlap',
      ]),
      attendanceReviewCode: attendanceDayReviewCodeSchema.nullable(),
      uncoveredAbsenceUnits: z.null(),
      workedMinutes: z.null(),
    }),
    z
      .strictObject({
        ...common,
        status: z.literal('composed_candidate'),
        policyId: id,
        policyVersion: z.number().int().positive(),
        qualification: z.enum([
          'half_day_work',
          'insufficient_work',
          'no_punch_work',
        ]),
        workUnits: units,
        paidLeaveUnits: units,
        unpaidLeaveUnits: units,
        uncoveredAbsenceUnits: units,
        leaveApprovalId: id,
        leaveApprovalVersion: z.number().int().positive(),
        workWindow: attendanceCompositionIntervalSchema,
        leaveWindow: attendanceCompositionIntervalSchema,
        breakWindows: attendanceCompositionIntervalSchema.array().max(2),
        firstPunchAt: z.iso.datetime().nullable(),
        lastPunchAt: z.iso.datetime().nullable(),
        coverageMappingId: id.nullable(),
        coverageMappingVersion: z.number().int().positive().nullable(),
        punchReferences: z
          .array(
            z.strictObject({
              connectorEventId: id,
              mappingId: id,
              mappingVersion: z.number().int().positive(),
            }),
          )
          .max(500),
        plannedWorkMilliseconds: ms,
        grossWorkedMilliseconds: ms,
        breakDeductedMilliseconds: ms,
        workedMilliseconds: ms,
        eligibleWorkedMilliseconds: ms,
        workedMinutes: z.number().min(0).max(1440),
        eligibleWorkedMinutes: z.number().min(0).max(1440),
        lateMilliseconds: ms,
        earlyMilliseconds: ms,
        isLate: z.boolean(),
        isEarly: z.boolean(),
        overtimeCandidateMilliseconds: ms,
        overtimePayable: z.literal(false),
      })
      .superRefine((v, c) => {
        const expectedWork = v.qualification === 'half_day_work' ? 0.5 : 0;
        const empty = v.qualification === 'no_punch_work';
        const badEvidence = empty
          ? v.firstPunchAt !== null ||
            v.lastPunchAt !== null ||
            v.coverageMappingId === null ||
            v.coverageMappingVersion === null ||
            v.punchReferences.length !== 0 ||
            v.grossWorkedMilliseconds !== 0 ||
            v.lateMilliseconds !== 0 ||
            v.earlyMilliseconds !== 0 ||
            v.isLate ||
            v.isEarly
          : v.firstPunchAt === null ||
            v.lastPunchAt === null ||
            Date.parse(v.lastPunchAt) <= Date.parse(v.firstPunchAt) ||
            v.punchReferences.length < 2 ||
            v.grossWorkedMilliseconds !==
              Date.parse(v.lastPunchAt) - Date.parse(v.firstPunchAt);
        if (
          v.workUnits !== expectedWork ||
          v.paidLeaveUnits + v.unpaidLeaveUnits !== 0.5 ||
          v.workUnits +
            v.paidLeaveUnits +
            v.unpaidLeaveUnits +
            v.uncoveredAbsenceUnits !==
            1 ||
          badEvidence ||
          new Set(v.punchReferences.map((p) => p.connectorEventId)).size !==
            v.punchReferences.length ||
          v.breakDeductedMilliseconds > v.grossWorkedMilliseconds ||
          v.workedMilliseconds !==
            v.grossWorkedMilliseconds - v.breakDeductedMilliseconds ||
          v.eligibleWorkedMilliseconds > v.workedMilliseconds ||
          v.eligibleWorkedMilliseconds > v.plannedWorkMilliseconds ||
          v.workedMinutes !== v.workedMilliseconds / 60000 ||
          v.eligibleWorkedMinutes !== v.eligibleWorkedMilliseconds / 60000 ||
          v.overtimeCandidateMilliseconds !==
            v.workedMilliseconds - v.eligibleWorkedMilliseconds
        )
          c.addIssue({
            code: 'custom',
            message: 'Inconsistent leave/work composition',
          });
      }),
  ],
);
export type AttendanceLeaveCompositionPreview = z.infer<
  typeof attendanceLeaveCompositionPreviewSchema
>;
