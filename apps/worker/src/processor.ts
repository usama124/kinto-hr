import type { Prisma, OutboxEvent } from '@prisma/client';
import type { PrismaClient } from '@kinto/database';
import { z } from 'zod';

// Queue data is a reference, never an authorization decision or HR payload.
export const referenceSchema = z.strictObject({
  eventId: z.uuid(),
  tenantId: z.uuid(),
});
export type EventReference = z.infer<typeof referenceSchema>;
export type Handler = (
  tx: Prisma.TransactionClient,
  event: OutboxEvent,
) => Promise<void>;
export const consumer = 'foundation-observer.v1';

export class ProcessingError extends Error {
  constructor(
    public readonly code:
      'UNSUPPORTED_EVENT' | 'TENANT_UNAVAILABLE' | 'EXPORT_UNAVAILABLE',
  ) {
    super(code);
  }
}

// The consumer records receipts for committed employee lifecycle facts and runs
// the one constrained aggregate export generator. The due transition remains a
// separate database command; this handler sends no email, transfers no salary
// and receives no direct employee, compensation or export-table access.
const handleCommittedEvent: Handler = async (tx, event) => {
  if (event.type === 'workforce_report_export.requested.v1') {
    const rows = await tx.$queryRaw<{ outcome: string }[]>`
      SELECT * FROM public.generate_tenant_workforce_report_export(
        ${event.tenantId}::uuid,${event.aggregateId}::uuid
      )`;
    if (!rows[0] || !['ready', 'expired'].includes(rows[0].outcome))
      throw new ProcessingError('EXPORT_UNAVAILABLE');
    return;
  }
  if (
    ![
      'employee.activated.v1',
      'employee.termination_scheduled.v1',
      'employee.terminated.v1',
      'employee.archived.v1',
      'employee.rehired.v1',
      'employee.account_reactivated.v1',
      'employee.private_details_changed.v1',
      'employee.compensation_changed.v1',
      'employee.checklist.created.v1',
      'employee.checklist.completed.v1',
      'employee.import_previewed.v1',
      'employee.import_committed.v1',
      'employee.document_registered.v1',
      'employee.document_quarantined.v1',
      'employee.document_clean.v1',
      'employee.document_rejected.v1',
      'employee.profile_change_requested.v1',
      'employee.profile_change_approved.v1',
      'employee.profile_change_rejected.v1',
    ].includes(event.type)
  )
    throw new ProcessingError('UNSUPPORTED_EVENT');
};

export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.round(
    Math.min(60000, 1000 * 2 ** (attempt - 1)) * (0.5 + random * 0.5),
  );
}

export async function processEvent(
  db: PrismaClient,
  data: unknown,
  handler: Handler = handleCommittedEvent,
) {
  const ref = referenceSchema.parse(data);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${ref.tenantId}, true)`;
      // Across processes: at most one transaction per tenant. Busy jobs stay durable/due.
      const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${ref.tenantId}::text, 1)) AS acquired`;
      if (!lock.acquired) return 'busy';
      const rows = await tx.$queryRaw<{ event_id: string }[]>`
      SELECT event_id FROM job_deliveries WHERE event_id = ${ref.eventId}::uuid FOR UPDATE`;
      if (rows.length === 0) return 'missing';
      const job = await tx.jobDelivery.findUniqueOrThrow({
        where: { eventId: ref.eventId },
      });
      if (job.status === 'completed' || job.status === 'dead')
        return job.status;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
      if (job.availableAt > clock.now) return 'deferred';
      const event = await tx.outboxEvent.findUniqueOrThrow({
        where: { id: ref.eventId },
      });
      const attempts = job.attempts + 1;

      // Keep the lock outside the savepoint. A failed handler must not commit partial
      // effects, but its sanitized retry/dead-letter state must survive the failure.
      await tx.$executeRawUnsafe('SAVEPOINT handler_effects');
      try {
        const tenant = await tx.tenant.findUnique({
          where: { id: ref.tenantId },
        });
        if (!tenant || tenant.status !== 'active')
          throw new ProcessingError('TENANT_UNAVAILABLE');
        await handler(tx, event);
        await tx.consumerReceipt.create({ data: { ...ref, consumer } });
        await tx.jobDelivery.update({
          where: { eventId: ref.eventId },
          data: {
            status: 'completed',
            attempts,
            completedAt: clock.now,
            lastError: null,
          },
        });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT handler_effects');
        return 'completed';
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT handler_effects');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT handler_effects');
        const status = attempts >= 5 ? 'dead' : 'retry';
        await tx.jobDelivery.update({
          where: { eventId: ref.eventId },
          data: {
            status,
            attempts,
            lastError:
              error instanceof ProcessingError ? error.code : 'HANDLER_FAILED',
            availableAt: new Date(clock.now.getTime() + retryDelay(attempts)),
          },
        });
        return status;
      }
    },
    { maxWait: 5000, timeout: 10000 },
  );
}
