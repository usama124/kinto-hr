import type { PrismaClient } from '@kinto/database';
import { z } from 'zod';

const replaySchema = z.strictObject({
  tenantId: z.uuid(),
  eventId: z.uuid(),
  actorId: z.uuid(),
  reason: z.string().trim().min(10).max(240),
});

// Operator-only helper. Never wire to an HTTP route without control-plane auth.
export async function replayOutbox(
  db: PrismaClient,
  input: z.input<typeof replaySchema>,
) {
  const data = replaySchema.parse(input);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${data.tenantId}, true)`;
    await tx.$queryRaw`SELECT event_id FROM job_deliveries WHERE tenant_id = ${data.tenantId}::uuid AND event_id = ${data.eventId}::uuid FOR UPDATE`;
    const job = await tx.jobDelivery.findFirst({
      where: { eventId: data.eventId, tenantId: data.tenantId },
    });
    const tenant = await tx.tenant.findUnique({ where: { id: data.tenantId } });
    if (!job || job.status !== 'dead' || tenant?.status !== 'active')
      throw new Error('REPLAY_NOT_ALLOWED');
    await tx.jobDelivery.update({
      where: { eventId: data.eventId },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        availableAt: new Date(),
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: data.tenantId,
        actorId: data.actorId,
        resourceId: data.eventId,
        action: 'outbox.replayed',
        reason: data.reason,
      },
    });
  });
}
