import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  attendanceBatchEnvelopeSchema,
  attendanceSourceEventSchema,
  attendanceAdapterVersionSchema,
  ATTENDANCE_BATCH_MAX_BYTES,
  type AttendanceSourceEvent,
} from '@kinto/contracts';

const scopeSchema = z.strictObject({
  tenantId: z.uuid().toLowerCase(),
  connectorId: z.uuid().toLowerCase(),
  deviceId: z.uuid().toLowerCase(),
  status: z.literal('active'),
  adapterVersion: attendanceAdapterVersionSchema,
  sourceIdentity: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unverified') }),
    z.strictObject({
      kind: z.literal('vendor_event_id'),
      resetEpoch: z.uuid().toLowerCase(),
    }),
  ]),
});
// Internal configuration boundary; its shape is NOT proof of authentication or
// hardware verification. Future machine auth/registry must supply fresh scope.
export type AttendanceConnectorScope = z.infer<typeof scopeSchema>;
export class AttendancePreflightError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_BATCH'
      | 'CONNECTOR_SCOPE_UNAVAILABLE'
      | 'DEVICE_NOT_ALLOWED'
      | 'ADAPTER_NOT_ALLOWED',
  ) {
    super(code);
  }
}
const digest = (values: unknown[]) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');
export type AttendanceCandidate = {
  index: number;
  state: 'candidate';
  connectorEventId: string;
  event: AttendanceSourceEvent;
  transportKey: string;
  contentHash: string;
  sourceKey: string | null;
  requiresSourceIdentityReview: boolean;
};
export type AttendanceRejection = {
  index: number;
  state: 'rejected_unstored';
  connectorEventId?: string;
  code:
    | 'invalid_event'
    | 'duplicate_transport_id'
    | 'source_identity_missing'
    | 'source_identity_conflict';
};

export function prepareAttendanceBatch(
  input: unknown,
  trustedScope: AttendanceConnectorScope,
) {
  const parsedScope = scopeSchema.safeParse(trustedScope);
  if (!parsedScope.success)
    throw new AttendancePreflightError('CONNECTOR_SCOPE_UNAVAILABLE');
  const scope = parsedScope.data;
  const batch = attendanceBatchEnvelopeSchema.safeParse(input);
  if (!batch.success) throw new AttendancePreflightError('INVALID_BATCH');
  try {
    // Also enforce raw HTTP body bytes when the machine route is implemented.
    if (
      Buffer.byteLength(JSON.stringify(input), 'utf8') >
      ATTENDANCE_BATCH_MAX_BYTES
    )
      throw new Error();
  } catch {
    throw new AttendancePreflightError('INVALID_BATCH');
  }
  if (batch.data.deviceId !== scope.deviceId)
    throw new AttendancePreflightError('DEVICE_NOT_ALLOWED');
  if (batch.data.adapterVersion !== scope.adapterVersion)
    throw new AttendancePreflightError('ADAPTER_NOT_ALLOWED');
  const ids = batch.data.events.map((event) => {
    const id = z
      .strictObject({ connectorEventId: z.uuid().toLowerCase() })
      .passthrough()
      .safeParse(event);
    return id.success ? id.data.connectorEventId : undefined;
  });
  const counts = new Map<string, number>();
  for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  const entries: (AttendanceCandidate | AttendanceRejection)[] =
    batch.data.events.map((raw, index) => {
      const connectorEventId = ids[index];
      if (connectorEventId && counts.get(connectorEventId)! > 1)
        return {
          index,
          state: 'rejected_unstored',
          connectorEventId,
          code: 'duplicate_transport_id',
        };
      const parsed = attendanceSourceEventSchema.safeParse(raw);
      if (!parsed.success)
        return {
          index,
          state: 'rejected_unstored',
          ...(connectorEventId ? { connectorEventId } : {}),
          code: 'invalid_event',
        };
      const event = parsed.data;
      if (
        scope.sourceIdentity.kind === 'vendor_event_id' &&
        !event.sourceEventId
      )
        return {
          index,
          state: 'rejected_unstored',
          connectorEventId: event.connectorEventId,
          code: 'source_identity_missing',
        };
      return {
        index,
        state: 'candidate',
        connectorEventId: event.connectorEventId,
        event,
        transportKey: digest([
          scope.tenantId,
          scope.connectorId,
          event.connectorEventId,
        ]),
        contentHash: digest([
          event.sourceUserId,
          event.sourceLocalTimestamp,
          event.sourceEventId ?? null,
          event.direction ?? null,
          event.workCode ?? null,
        ]),
        sourceKey:
          scope.sourceIdentity.kind === 'vendor_event_id'
            ? digest([
                scope.tenantId,
                scope.deviceId,
                scope.sourceIdentity.resetEpoch,
                event.sourceEventId,
              ])
            : null,
        requiresSourceIdentityReview:
          scope.sourceIdentity.kind === 'unverified',
      };
    });
  // Contradictory source identities in one batch must never pick a winner by order.
  const sourceHashes = new Map<string, Set<string>>();
  for (const entry of entries)
    if (entry.state === 'candidate' && entry.sourceKey) {
      const hashes = sourceHashes.get(entry.sourceKey) ?? new Set<string>();
      hashes.add(entry.contentHash);
      sourceHashes.set(entry.sourceKey, hashes);
    }
  return {
    batchId: batch.data.batchId,
    deviceId: scope.deviceId,
    tenantId: scope.tenantId,
    connectorId: scope.connectorId,
    entries: entries.map((entry) =>
      entry.state === 'candidate' &&
      entry.sourceKey &&
      sourceHashes.get(entry.sourceKey)!.size > 1
        ? {
            index: entry.index,
            state: 'rejected_unstored' as const,
            connectorEventId: entry.connectorEventId,
            code: 'source_identity_conflict' as const,
          }
        : entry,
    ),
  };
}
