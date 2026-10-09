import { z } from 'zod';
import { attendanceSourceEventSchema } from './attendance';
import {
  deviceMappingQuerySchema,
  deviceMappingResolveQuerySchema,
  deviceMappingResolutionSchema,
} from './device-mappings';
const id = z.uuid().toLowerCase();
export const syntheticInboxReviewQuerySchema = deviceMappingQuerySchema;
export const syntheticInboxPreviewQuerySchema = z.strictObject({
  at: deviceMappingResolveQuerySchema.shape.at,
});
export const syntheticInboxEventSchema = z.strictObject({
  id,
  deviceId: id,
  payload: attendanceSourceEventSchema.omit({ connectorEventId: true }),
  quarantineCode: z.literal('source_identity_unverified'),
  createdAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value).toISOString()),
});
const guards = {
  sourceIdentityVerified: z.literal(false),
  clockVerified: z.literal(false),
  attendanceProcessingAvailable: z.literal(false),
};
export const syntheticInboxReviewListSchema = z.strictObject({
  tenantId: id,
  deviceId: id,
  items: syntheticInboxEventSchema.array().max(50),
  nextCursor: id.nullable(),
  ...guards,
});
export const syntheticInboxMappingPreviewSchema = z.strictObject({
  event: syntheticInboxEventSchema,
  requestedAt: deviceMappingResolveQuerySchema.shape.at,
  timeBasis: z.literal('operator_supplied_unverified'),
  resolution: deviceMappingResolutionSchema,
  ...guards,
});
