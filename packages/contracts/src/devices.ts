import { z } from 'zod';

const id = z.uuid().toLowerCase();
const metadata = {
  branchId: id,
  name: z.string().trim().min(1).max(160),
  model: z.literal('ZKTeco_K50'),
  firmware: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/)
    .nullable(),
  sourceTimezone: z.literal('Asia/Karachi'),
};
export const deviceCreateSchema = z.strictObject({
  ...metadata,
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/),
  reason: z.literal('initial_setup'),
});
export const deviceUpdateSchema = z
  .strictObject({
    ...metadata,
    expectedVersion: z.number().int().min(1).max(2147483646),
    status: z.enum(['draft', 'retired']),
    reason: z.enum(['metadata_correction', 'retire_device']),
  })
  .superRefine((value, context) => {
    if ((value.status === 'retired') !== (value.reason === 'retire_device'))
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Reason must match inventory transition',
      });
  });
export const deviceListQuerySchema = z.strictObject({
  afterId: id.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export const deviceInventoryItemSchema = z.strictObject({
  ...metadata,
  id,
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/),
  version: z.number().int().min(1),
  status: z.enum(['draft', 'retired']),
  adapterVersion: z.null(),
  sourceIdentityStatus: z.literal('unverified'),
  health: z.literal('not_connected'),
  lastSyncAt: z.null(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const deviceInventorySchema = z.strictObject({
  items: deviceInventoryItemSchema.array().max(50),
  nextCursor: id.nullable(),
});
export type DeviceCreate = z.infer<typeof deviceCreateSchema>;
export type DeviceUpdate = z.infer<typeof deviceUpdateSchema>;
export type DeviceListQuery = z.infer<typeof deviceListQuerySchema>;
