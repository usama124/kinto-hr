import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { attendanceBatchReceiptSchema } from '@kinto/contracts';
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
}
