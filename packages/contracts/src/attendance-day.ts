import { z } from 'zod';
import {
  attendanceNormalizedPreviewSchema,
  attendanceScheduleCandidatesSchema,
} from './attendance-normalization';
import { deviceMappingItemSchema } from './device-mappings';

const id = z.uuid().toLowerCase();
// Internal synthetic preview only. These context values require independent
// trusted resolution before any mounted calculation; they are not authorization.
export const attendanceDayPreviewInputSchema = z.strictObject({
  tenantId: id,
  deviceId: id,
  employeeId: id,
  workDate: z.iso.date(),
  schedules: z.union([attendanceScheduleCandidatesSchema, z.tuple([])]),
  coverageMapping: deviceMappingItemSchema.nullable(),
  employment: z.enum(['employed', 'not_employed', 'unknown']),
  calendar: z.enum(['working_day', 'holiday', 'rest_day', 'unknown']),
  leave: z.enum(['none', 'approved_full_day', 'partial_or_pending']),
  evidence: z.enum(['complete_closed', 'incomplete']),
  periodState: z.enum(['open', 'locked']),
  punchRule: z.enum(['verified_in_out', 'approved_first_last']),
  punches: z
    .array(
      z.strictObject({
        normalized: attendanceNormalizedPreviewSchema,
        mapping: deviceMappingItemSchema.nullable(),
      }),
    )
    .max(500),
});
export const attendanceDayReviewCodeSchema = z.enum([
  'locked_period',
  'employment_unknown',
  'calendar_unknown',
  'leave_composition_required',
  'non_workday_punches',
  'unknown_schedule',
  'calendar_policy_conflict',
  'incomplete_evidence',
  'normalization_unverified',
  'mapping_unresolved',
  'mapping_source_mismatch',
  'mapping_outside_interval',
  'association_unresolved',
  'wrong_workdate',
  'outside_window',
  'conflicting_duplicate',
  'source_identity_conflict',
  'missing_punch',
  'ambiguous_punches',
  'direction_rule_mismatch',
]);
const milliseconds = z.number().int().min(0).max(86400000);
const common = {
  tenantId: id,
  deviceId: id,
  employeeId: id,
  workDate: z.iso.date(),
  calculationVersion: z.literal(1),
  policyId: id.nullable(),
  policyVersion: z.number().int().positive().nullable(),
  coverageMappingId: id.nullable(),
  coverageMappingVersion: z.number().int().positive().nullable(),
  attendanceProcessingAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
export const attendanceDayPreviewSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...common,
    status: z.literal('needs_review'),
    code: attendanceDayReviewCodeSchema,
    uncoveredAbsenceUnits: z.null(),
    workedMinutes: z.null(),
  }),
  z.strictObject({
    ...common,
    status: z.enum(['not_employed', 'holiday', 'rest_day', 'leave']),
    uncoveredAbsenceUnits: z.null(),
    workedMinutes: z.null(),
  }),
  z
    .strictObject({
      ...common,
      status: z.literal('qualified_candidate'),
      policyId: id,
      policyVersion: z.number().int().positive(),
      qualification: z.enum([
        'full_day',
        'half_day',
        'insufficient',
        'no_punch_absence',
      ]),
      uncoveredAbsenceUnits: z.union([
        z.literal(0),
        z.literal(0.5),
        z.literal(1),
      ]),
      firstPunchAt: z.iso.datetime().nullable(),
      lastPunchAt: z.iso.datetime().nullable(),
      uniquePunchCount: z.number().int().min(0).max(500),
      punchReferences: z
        .array(
          z.strictObject({
            connectorEventId: id,
            mappingId: id,
            mappingVersion: z.number().int().positive(),
          }),
        )
        .max(500),
      scheduledMinutes: z.number().int().positive(),
      netScheduledMinutes: z.number().int().positive(),
      grossWorkedMilliseconds: milliseconds,
      breakDeductedMilliseconds: milliseconds,
      eligibleBreakDeductedMilliseconds: milliseconds,
      workedMilliseconds: milliseconds,
      eligibleWorkedMilliseconds: milliseconds,
      workedMinutes: z.number().min(0).max(1440),
      eligibleWorkedMinutes: z.number().min(0).max(1440),
      lateMilliseconds: milliseconds,
      earlyMilliseconds: milliseconds,
      isLate: z.boolean(),
      isEarly: z.boolean(),
      overtimeCandidateMilliseconds: milliseconds,
      overtimePayable: z.literal(false),
    })
    .superRefine((v, context) => {
      const units =
        v.qualification === 'full_day'
          ? 0
          : v.qualification === 'half_day'
            ? 0.5
            : 1;
      const empty = v.qualification === 'no_punch_absence';
      const invalidEvidence = empty
        ? v.coverageMappingId === null ||
          v.coverageMappingVersion === null ||
          v.uniquePunchCount !== 0 ||
          v.firstPunchAt !== null ||
          v.lastPunchAt !== null ||
          v.grossWorkedMilliseconds !== 0 ||
          v.lateMilliseconds !== 0 ||
          v.earlyMilliseconds !== 0 ||
          v.isLate ||
          v.isEarly
        : v.uniquePunchCount < 2 ||
          v.firstPunchAt === null ||
          v.lastPunchAt === null ||
          Date.parse(v.lastPunchAt) <= Date.parse(v.firstPunchAt) ||
          v.grossWorkedMilliseconds !==
            Date.parse(v.lastPunchAt) - Date.parse(v.firstPunchAt);
      if (
        v.uncoveredAbsenceUnits !== units ||
        invalidEvidence ||
        v.uniquePunchCount !== v.punchReferences.length ||
        new Set(v.punchReferences.map((p) => p.connectorEventId)).size !==
          v.punchReferences.length ||
        v.netScheduledMinutes > v.scheduledMinutes ||
        v.breakDeductedMilliseconds > v.grossWorkedMilliseconds ||
        v.workedMilliseconds !==
          v.grossWorkedMilliseconds - v.breakDeductedMilliseconds ||
        v.eligibleWorkedMilliseconds > v.workedMilliseconds ||
        v.eligibleWorkedMilliseconds > v.netScheduledMinutes * 60000 ||
        v.eligibleBreakDeductedMilliseconds > v.breakDeductedMilliseconds ||
        v.workedMinutes !== v.workedMilliseconds / 60000 ||
        v.eligibleWorkedMinutes !== v.eligibleWorkedMilliseconds / 60000 ||
        v.overtimeCandidateMilliseconds !==
          v.workedMilliseconds - v.eligibleWorkedMilliseconds
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Inconsistent day qualification or evidence',
        });
      }
    }),
]);
export type AttendanceDayReviewCode = z.infer<
  typeof attendanceDayReviewCodeSchema
>;
export type AttendanceDayPreview = z.infer<typeof attendanceDayPreviewSchema>;
