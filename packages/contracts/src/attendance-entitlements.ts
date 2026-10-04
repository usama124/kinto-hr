import { z } from 'zod';

// Technical allocation bounds, not commercial plan defaults or K50 approval.
export const attendanceAllocationSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(0).max(2147483646),
    enabled: z.boolean(),
    deviceLimit: z.number().int().min(0).max(1000),
    connectorLimit: z.number().int().min(0).max(1000),
    reason: z.enum([
      'initial_setup',
      'allocation_change',
      'disable_attendance',
    ]),
  })
  .superRefine((value, context) => {
    const valid = value.enabled
      ? value.deviceLimit > 0 &&
        value.connectorLimit > 0 &&
        value.reason ===
          (value.expectedVersion === 0 ? 'initial_setup' : 'allocation_change')
      : value.deviceLimit === 0 &&
        value.connectorLimit === 0 &&
        value.expectedVersion > 0 &&
        value.reason === 'disable_attendance';
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'Allocation and reason must match the transition',
      });
  });
export const attendanceAllocationSnapshotSchema = z
  .strictObject({
    tenantId: z.uuid().toLowerCase(),
    version: z.number().int().min(0),
    enabled: z.boolean(),
    deviceLimit: z.number().int().min(0).max(1000),
    connectorLimit: z.number().int().min(0).max(1000),
    configuredAt: z.iso.datetime({ offset: true }).nullable(),
    // This increment allocates capacity only. No machine auth or activation exists.
    machineAccessAvailable: z.literal(false),
  })
  .superRefine((value, context) => {
    if (
      (value.enabled
        ? value.deviceLimit === 0 || value.connectorLimit === 0
        : value.deviceLimit !== 0 || value.connectorLimit !== 0) ||
      (value.version === 0
        ? value.enabled || value.configuredAt !== null
        : value.configuredAt === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid allocation snapshot',
      });
  });
export const attendanceAllocationResultSchema = z.strictObject({
  id: z.uuid().toLowerCase(),
  version: z.number().int().positive(),
  replayed: z.boolean(),
});
export type AttendanceAllocation = z.infer<typeof attendanceAllocationSchema>;
