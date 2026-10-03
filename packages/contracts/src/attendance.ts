import { z } from 'zod';

export const ATTENDANCE_BATCH_MAX_EVENTS = 500;
export const ATTENDANCE_BATCH_MAX_BYTES = 1_000_000;
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const attendanceAdapterVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const attendanceSourceEventSchema = z.strictObject({
  connectorEventId: z.uuid().toLowerCase(),
  // Do not coerce IDs to numbers or trim/alter source values.
  sourceUserId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  sourceLocalTimestamp: z.iso
    .datetime({ local: true })
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/),
  sourceEventId: identifier.optional(),
  direction: z.enum(['in', 'out']).optional(),
  workCode: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,32}$/)
    .optional(),
});
// Validate events separately, preserving per-record rejection and original order.
export const attendanceBatchEnvelopeSchema = z.strictObject({
  batchId: z.uuid().toLowerCase(),
  schemaVersion: z.literal(1),
  deviceId: z.uuid().toLowerCase(),
  adapterVersion: attendanceAdapterVersionSchema,
  events: z.unknown().array().min(1).max(ATTENDANCE_BATCH_MAX_EVENTS),
});
export const attendanceEventDispositionSchema = z.discriminatedUnion(
  'disposition',
  [
    z.strictObject({
      index: z.number().int().min(0).max(499),
      connectorEventId: z.uuid().toLowerCase(),
      disposition: z.enum(['stored', 'duplicate']),
    }),
    z.strictObject({
      index: z.number().int().min(0).max(499),
      connectorEventId: z.uuid().toLowerCase(),
      disposition: z.literal('quarantined'),
      code: z.enum([
        'source_identity_unverified',
        'unknown_device_user',
        'mapping_ambiguous',
        'clock_suspect',
      ]),
    }),
    z.strictObject({
      index: z.number().int().min(0).max(499),
      connectorEventId: z.uuid().toLowerCase().optional(),
      disposition: z.literal('rejected_unstored'),
      code: z.enum([
        'invalid_event',
        'duplicate_transport_id',
        'source_identity_missing',
        'source_identity_conflict',
      ]),
    }),
  ],
);
export const attendanceBatchReceiptSchema = z
  .strictObject({
    receiptId: z.uuid().toLowerCase(),
    batchId: z.uuid().toLowerCase(),
    deviceId: z.uuid().toLowerCase(),
    schemaVersion: z.literal(1),
    events: attendanceEventDispositionSchema
      .array()
      .min(1)
      .max(ATTENDANCE_BATCH_MAX_EVENTS),
  })
  .superRefine((receipt, context) => {
    if (receipt.events.some((event, index) => event.index !== index))
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Receipt entries must cover consecutive input indexes',
      });
  });
export type AttendanceSourceEvent = z.infer<typeof attendanceSourceEventSchema>;
export type AttendanceEventDisposition = z.infer<
  typeof attendanceEventDispositionSchema
>;
export type AttendanceBatchReceipt = z.infer<
  typeof attendanceBatchReceiptSchema
>;
