import { z } from 'zod';
import { attendanceSourceEventSchema } from './attendance';
import { attendanceTimingPolicySchema } from './attendance-timing';

const id = z.uuid().toLowerCase();
const instant = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
const safeMilliseconds = z.number().int().min(0).max(86400000);
// Internal synthetic calculation inputs, NOT machine authentication or proof.
// Future registry/clock verification must supply this evidence independently of uploads.
export const attendanceNormalizationContextSchema = z.strictObject({
  tenantId: id,
  deviceId: id,
  timeZone: z.literal('Asia/Karachi'),
  receivedAt: instant,
  sourceIdentity: z.enum(['unverified', 'verified']),
  clock: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('unverified') }),
    z.strictObject({
      status: z.literal('verified'),
      observedDriftMilliseconds: z
        .number()
        .int()
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      maximumAbsoluteDriftMilliseconds: safeMilliseconds,
      maximumFutureLeadMilliseconds: safeMilliseconds,
    }),
  ]),
});
export const attendanceNormalizationReviewCodeSchema = z.enum([
  'source_identity_unverified',
  'clock_unverified',
  'clock_suspect',
  'unsupported_timezone_offset',
  'event_in_future',
]);
const common = {
  tenantId: id,
  deviceId: id,
  timeZone: z.literal('Asia/Karachi'),
  receivedAt: instant,
  source: attendanceSourceEventSchema,
  attendanceProcessingAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
export const attendanceNormalizedPreviewSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      ...common,
      status: z.literal('candidate'),
      occurredAt: instant,
      reviewCodes: z.tuple([]),
    }),
    z.strictObject({
      ...common,
      status: z.literal('needs_review'),
      occurredAt: z.null(),
      reviewCodes: attendanceNormalizationReviewCodeSchema
        .array()
        .min(1)
        .max(5),
    }),
  ],
);
export const attendanceScheduleCandidatesSchema = z
  .array(
    z.strictObject({
      tenantId: id,
      deviceId: id,
      workDate: z.iso.date(),
      policy: attendanceTimingPolicySchema.refine(
        (v) => v.status === 'published',
        'Schedule requires a published policy',
      ),
    }),
  )
  .min(1)
  .max(3);
export type AttendanceNormalizedPreview = z.infer<
  typeof attendanceNormalizedPreviewSchema
>;
