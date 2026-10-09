import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  attendanceBatchReceiptSchema,
  syntheticInboxReviewQuerySchema,
  syntheticInboxPreviewQuerySchema,
  syntheticInboxEventSchema,
  syntheticInboxReviewListSchema,
  syntheticInboxMappingPreviewSchema,
} from '@kinto/contracts';
import { createDatabase, type OrganizationActor } from '@kinto/database';
import { DomainError } from '@kinto/domain';
import {
  prepareAttendanceBatch,
  type AttendanceConnectorScope,
} from './preflight';

// Internal fixture tool, deliberately not mounted in HTTP or machine authority.
// All canonical events stay quarantined; fixture source identities are not K50 proof.
export class SyntheticAttendanceInbox {
  private readonly db;
  constructor(databaseUrl: string) {
    const url = new URL(databaseUrl);
    if (
      process.env.NODE_ENV === 'production' ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^\/kinto_test[_a-zA-Z0-9]*$/.test(url.pathname)
    )
      throw new Error(
        'Synthetic attendance inbox requires a non-production loopback kinto_test database',
      );
    this.db = createDatabase(databaseUrl);
  }
  async close() {
    await this.db.$disconnect();
  }
  async store(
    actor: OrganizationActor,
    input: unknown,
    fixture: AttendanceConnectorScope,
  ) {
    z.uuid().parse(actor.identityId);
    z.boolean().parse(actor.mfaVerified);
    const prepared = prepareAttendanceBatch(input, fixture);
    // Only sanitized records/rejection codes enter SQL. Invalid biometric payloads
    // are neither persisted nor hashed into receipts. Transport/source hashes from
    // preflight are internal fixture keys, never machine authentication.
    const packet = prepared.entries.map((entry) =>
      entry.state === 'candidate'
        ? {
            index: entry.index,
            state: entry.state,
            connectorEventId: entry.connectorEventId,
            event: entry.event,
            sourceKey: entry.sourceKey,
          }
        : entry,
    );
    const [row] = await this.db.$queryRaw<
      { outcome: string; snapshot: unknown }[]
    >`
      SELECT * FROM public.store_synthetic_attendance_batch(${actor.identityId}::uuid,${actor.mfaVerified},${prepared.tenantId}::uuid,${prepared.deviceId}::uuid,${prepared.connectorId}::uuid,${prepared.batchId}::uuid,${JSON.stringify(packet)}::jsonb,${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
    if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
    if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
    if (row.outcome !== 'ok') throw new DomainError('INVALID_STATE');
    return attendanceBatchReceiptSchema.parse(row.snapshot);
  }
  // These methods remain internal/local-only, with fresh SQL owner/HR/MFA checks.
  async review(
    actor: OrganizationActor,
    tenantId: string,
    deviceId: string,
    query: unknown = {},
  ) {
    this.validateReviewScope(actor, tenantId, deviceId);
    const input = syntheticInboxReviewQuerySchema.parse(query);
    const [row] = await this.db.$queryRaw<
      { outcome: string; snapshot: unknown }[]
    >`
      SELECT * FROM public.read_synthetic_attendance_events(${actor.identityId}::uuid,${actor.mfaVerified},${tenantId}::uuid,${deviceId}::uuid,${input.limit}::integer,${input.afterId ?? null}::uuid)`;
    this.assertReview(row);
    const items = syntheticInboxEventSchema.array().max(51).parse(row.snapshot);
    if (items.some((item) => item.deviceId !== deviceId.toLowerCase()))
      throw new DomainError('INVALID_STATE');
    const page = items.slice(0, input.limit);
    return syntheticInboxReviewListSchema.parse({
      tenantId,
      deviceId,
      items: page,
      nextCursor: items.length > input.limit ? page.at(-1)!.id : null,
      sourceIdentityVerified: false,
      clockVerified: false,
      attendanceProcessingAvailable: false,
    });
  }
  async previewMapping(
    actor: OrganizationActor,
    tenantId: string,
    deviceId: string,
    eventId: string,
    query: unknown,
  ) {
    this.validateReviewScope(actor, tenantId, deviceId);
    z.uuid().parse(eventId);
    const input = syntheticInboxPreviewQuerySchema.parse(query);
    const [row] = await this.db.$queryRaw<
      { outcome: string; snapshot: unknown }[]
    >`
      SELECT * FROM public.preview_synthetic_attendance_mapping(${actor.identityId}::uuid,${actor.mfaVerified},${tenantId}::uuid,${deviceId}::uuid,${eventId}::uuid,${new Date(input.at)}::timestamptz)`;
    this.assertReview(row);
    const result = syntheticInboxMappingPreviewSchema.parse(row.snapshot);
    if (
      result.event.id !== eventId.toLowerCase() ||
      result.event.deviceId !== deviceId.toLowerCase() ||
      result.requestedAt !== input.at
    )
      throw new DomainError('INVALID_STATE');
    return result;
  }
  private validateReviewScope(
    actor: OrganizationActor,
    tenant: string,
    device: string,
  ) {
    z.uuid().parse(actor.identityId);
    z.boolean().parse(actor.mfaVerified);
    z.uuid().parse(tenant);
    z.uuid().parse(device);
  }
  private assertReview(row?: {
    outcome: string;
    snapshot: unknown;
  }): asserts row is { outcome: string; snapshot: unknown } {
    if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
    if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
    if (row.outcome !== 'ok') throw new DomainError('INVALID_STATE');
  }
}
