import { z } from 'zod';
const uuid = z.uuid().toLowerCase();
export const enrollmentIssueSchema = z.strictObject({
  deviceId: uuid,
  expectedDeviceVersion: z.number().int().positive().max(2147483646),
  expectedAllocationVersion: z.number().int().positive().max(2147483646),
});
export const enrollmentRevokeSchema = z.strictObject({
  expectedVersion: z.literal(1),
});
export const enrollmentItemSchema = z
  .strictObject({
    id: uuid,
    deviceId: uuid,
    expectedDeviceVersion: z.number().int().positive(),
    allocationVersion: z.number().int().positive(),
    version: z.union([z.literal(1), z.literal(2)]),
    status: z.enum(['issued', 'expired', 'revoked']),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    revokedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== 900000 ||
      (value.status === 'revoked'
        ? value.version !== 2 || value.revokedAt === null
        : value.version !== 1 || value.revokedAt !== null)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid enrollment state' });
  });
export const enrollmentIssueResultSchema = z
  .strictObject({
    enrollment: enrollmentItemSchema,
    replayed: z.boolean(),
    token: z
      .string()
      .regex(/^ke1_[A-Za-z0-9_-]{43}$/)
      .nullable(),
    machineAccessAvailable: z.literal(false),
  })
  .superRefine((value, ctx) => {
    if (
      value.replayed
        ? value.token !== null
        : value.token === null || value.enrollment.status !== 'issued'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Token is revealed only on initial issuance',
      });
  });
export const enrollmentListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  afterId: uuid.optional(),
});
export const enrollmentListSchema = z.strictObject({
  items: z.array(enrollmentItemSchema).max(50),
  nextCursor: uuid.nullable(),
  machineAccessAvailable: z.literal(false),
});
export type EnrollmentIssue = z.infer<typeof enrollmentIssueSchema>;
export type EnrollmentListQuery = z.infer<typeof enrollmentListQuerySchema>;
