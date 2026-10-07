import { z } from 'zod';
const id = z.uuid().toLowerCase();
// Provisional sanitized source identifier, never numeric coercion or trimming.
export const deviceSourceUserIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/);
const instant = z.iso
  .datetime({ offset: true })
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value)) &&
      Date.parse(value) >= Date.parse('2000-01-01T00:00:00Z') &&
      Date.parse(value) < Date.parse('2100-01-01T00:00:00Z'),
  )
  .transform((value) => new Date(value).toISOString());
const interval = { effectiveFrom: instant, effectiveUntil: instant.nullable() };
const validInterval = (value: {
  effectiveFrom: string;
  effectiveUntil: string | null;
}) =>
  value.effectiveUntil === null ||
  Date.parse(value.effectiveUntil) > Date.parse(value.effectiveFrom);
export const deviceMappingCreateSchema = z
  .strictObject({
    employeeId: id,
    sourceUserId: deviceSourceUserIdSchema,
    ...interval,
    reason: z.literal('initial_mapping'),
  })
  .refine(validInterval, {
    message: 'Mapping end must follow start',
    path: ['effectiveUntil'],
  });
export const deviceMappingEndSchema = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2147483646),
  effectiveUntil: instant,
  reason: z.literal('end_mapping'),
});
export const deviceMappingQuerySchema = z.strictObject({
  afterId: id.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export const deviceMappingItemSchema = z
  .strictObject({
    id,
    deviceId: id,
    employeeId: id,
    sourceUserId: deviceSourceUserIdSchema,
    ...interval,
    version: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .refine(validInterval);
export const deviceMappingListSchema = z.strictObject({
  tenantId: id,
  deviceId: id,
  items: z.array(deviceMappingItemSchema).max(50),
  nextCursor: id.nullable(),
  attendanceProcessingAvailable: z.literal(false),
});
export const deviceMappingMutationSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  replayed: z.boolean(),
});
export const deviceMappingResolveQuerySchema = z.strictObject({
  sourceUserId: deviceSourceUserIdSchema,
  at: instant,
});
export const deviceMappingResolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('mapped'),
    mappingId: id,
    mappingVersion: z.number().int().positive(),
    employeeId: id,
  }),
  z.strictObject({
    status: z.enum(['unmapped', 'ambiguous']),
    mappingId: z.null(),
    mappingVersion: z.null(),
    employeeId: z.null(),
  }),
]);
export type DeviceMappingCreate = z.infer<typeof deviceMappingCreateSchema>;
export type DeviceMappingEnd = z.infer<typeof deviceMappingEndSchema>;
export type DeviceMappingQuery = z.infer<typeof deviceMappingQuerySchema>;
export type DeviceMappingResolveQuery = z.infer<
  typeof deviceMappingResolveQuerySchema
>;
