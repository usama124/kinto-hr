import { z } from 'zod';
import {
  leavePolicyDraftSchema,
  leavePolicySettingsSchema,
} from './leave-quota';
const id = z.uuid().toLowerCase();
const version = z.number().int().positive().max(2147483647);
const utc = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
const date = z.iso
  .date()
  .refine((v) => !v.startsWith('0000'), 'Calendar year must be at least 1');
export const leavePolicyDraftInputSchema = leavePolicyDraftSchema.refine(
  (v) => !v.effectiveFrom.startsWith('0000'),
  'Calendar year must be at least 1',
);
export const leaveTypeCreateSchema = leavePolicyDraftInputSchema.refine(
  (v) => v.expectedCurrentVersion === 0,
  'A new leave type must start without a published base',
);
export const leavePolicyPublishSchema = z.strictObject({
  expectedVersion: version,
  reason: z.string().trim().min(3).max(240),
});
export const leavePolicyQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  afterId: id.optional(),
  asOf: date.optional(),
});
export const leaveTypeQuerySchema = leavePolicyQuerySchema.omit({ asOf: true });
export const leaveTypeSchema = z.strictObject({
  id,
  code: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/),
  createdAt: utc,
});
export const leavePolicyRecordSchema = z
  .strictObject({
    id,
    tenantId: id,
    leaveTypeId: id,
    version,
    basedOnVersion: z.number().int().nonnegative().max(2147483646),
    status: z.enum(['draft', 'published']),
    effectiveFrom: date,
    effectiveUntil: date.nullable(),
    settings: leavePolicySettingsSchema,
    reason: z.string().min(3).max(240),
    createdAt: utc,
    publishedAt: utc.nullable(),
  })
  .superRefine((v, c) => {
    if (
      v.basedOnVersion >= v.version ||
      (v.status === 'published') !== (v.publishedAt !== null) ||
      (v.status === 'draft' && v.effectiveUntil !== null) ||
      (v.effectiveUntil !== null && v.effectiveUntil <= v.effectiveFrom)
    )
      c.addIssue({
        code: 'custom',
        message: 'Invalid leave policy publication/interval',
      });
  });
const flags = {
  leaveReservationAvailable: z.literal(false),
  payrollEffectsAvailable: z.literal(false),
};
export const leaveTypeListSchema = z.strictObject({
  tenantId: id,
  items: leaveTypeSchema.array().max(50),
  nextCursor: id.nullable(),
  ...flags,
});
export const leavePolicyListSchema = z.strictObject({
  tenantId: id,
  leaveType: leaveTypeSchema,
  asOf: z.iso.date(),
  latestPublishedVersion: z.number().int().nonnegative(),
  currentPolicy: leavePolicyRecordSchema.nullable(),
  items: leavePolicyRecordSchema.array().max(50),
  nextCursor: id.nullable(),
  ...flags,
});
export const leavePolicyMutationSchema = z.strictObject({
  leaveTypeId: id,
  id,
  version,
  replayed: z.boolean(),
});
export type LeavePolicyRecord = z.infer<typeof leavePolicyRecordSchema>;
