import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateEmployee,
  createDatabase,
  createEmployeeDraft,
  inTenant,
} from '@kinto/database';
import {
  processEvent,
  type EventReference,
} from '../../apps/worker/src/processor';
import { startWorker } from '../../apps/worker/src/runtime';
import { workerConfig } from '../../apps/worker/src/config';
import { replayOutbox } from '../../scripts/lib/replay-outbox';
import {
  activeWorkers,
  publishHeartbeat,
  removeHeartbeat,
  readHealth,
  healthAlerts,
} from '../../apps/worker/src/health';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = workerConfig(process.env);
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
for (const url of [
  adminUrl,
  appUrl,
  config.WORKER_DATABASE_URL,
  config.DISPATCHER_DATABASE_URL,
])
  if (!url || !new URL(url).pathname.startsWith('/kinto_test'))
    throw new Error('Worker tests require explicit kinto_test* database URLs');
const admin = createDatabase(adminUrl!);
const app = createDatabase(appUrl!);
const worker = createDatabase(config.WORKER_DATABASE_URL);
const dispatcher = createDatabase(config.DISPATCHER_DATABASE_URL);
const actor = randomUUID();
let tenantA: string;
let tenantB: string;
let runtime: Awaited<ReturnType<typeof startWorker>> | undefined;

async function activation(tenantId = tenantA): Promise<EventReference> {
  const employee = await createEmployeeDraft(
    app,
    tenantId,
    { employeeNumber: randomUUID(), name: 'Synthetic worker fixture' },
    actor,
  );
  await activateEmployee(app, tenantId, employee.id, 1, actor);
  const event = await admin.outboxEvent.findFirstOrThrow({
    where: { tenantId, aggregateId: employee.id },
  });
  return { eventId: event.id, tenantId };
}
const pending = () =>
  dispatcher.$queryRaw<
    EventReference[]
  >`SELECT * FROM public.pending_outbox(100)`;
const delivery = (ref: EventReference) =>
  admin.jobDelivery.findUniqueOrThrow({ where: { eventId: ref.eventId } });
const makeDue = (ref: EventReference) =>
  admin.jobDelivery.update({
    where: { eventId: ref.eventId },
    data: { availableAt: new Date(0) },
  });

describe('durable outbox worker with real PostgreSQL and Redis', () => {
  beforeEach(async () => {
    tenantA = randomUUID();
    tenantB = randomUUID();
    await admin.tenant.createMany({
      data: [tenantA, tenantB].map((id) => ({
        id,
        name: 'Synthetic worker tenant',
        employeeLimit: 20,
      })),
    });
  });
  afterEach(async () => {
    if (runtime) {
      await runtime.queue.pause();
      // Only this test's UUID-named queue is removed; never FLUSHDB/shared cleanup.
      await runtime.queue.obliterate({ force: true });
      await runtime.close();
      runtime = undefined;
    }
    const where = { tenantId: { in: [tenantA, tenantB] } };
    await admin.outboxEvent.deleteMany({ where });
    await admin.auditEvent.deleteMany({ where });
    await admin.employee.deleteMany({ where });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
  });
  afterAll(async () => {
    await Promise.all(
      [admin, app, worker, dispatcher].map((db) => db.$disconnect()),
    );
  });

  it('enqueues atomically and never dispatches an uncommitted/rolled-back event', async () => {
    const id = randomUUID();
    await expect(
      admin.$transaction(async (tx) => {
        await tx.outboxEvent.create({
          data: {
            id,
            tenantId: tenantA,
            type: 'employee.activated.v1',
            aggregateId: randomUUID(),
            aggregateVersion: 1,
          },
        });
        expect(await tx.jobDelivery.count({ where: { eventId: id } })).toBe(1);
        expect(await pending()).not.toContainEqual({
          eventId: id,
          tenantId: tenantA,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await admin.jobDelivery.count({ where: { eventId: id } })).toBe(0);
    const ref = await activation();
    expect(await pending()).toContainEqual(ref);
  });

  it('restricts dispatcher to metadata functions and worker to delivery tables', async () => {
    await activation();
    await expect(dispatcher.employee.findMany()).rejects.toThrow();
    await expect(dispatcher.outboxEvent.findMany()).rejects.toThrow();
    await expect(dispatcher.jobDelivery.findMany()).rejects.toThrow();
    await expect(worker.employee.findMany()).rejects.toThrow();
    await expect(worker.auditEvent.findMany()).rejects.toThrow();
    await expect(
      app.$queryRaw`SELECT * FROM public.pending_outbox(100)`,
    ).rejects.toThrow();
    await expect(
      worker.$queryRaw`SELECT * FROM public.pending_outbox(100)`,
    ).rejects.toThrow();
    await expect(
      inTenant(worker, tenantA, (tx) => tx.jobDelivery.deleteMany()),
    ).rejects.toThrow();
    expect(await pending()).toEqual(
      expect.arrayContaining([expect.objectContaining({ tenantId: tenantA })]),
    );
  });

  it('fails closed without context and cannot consume a different tenant event', async () => {
    const ref = await activation(tenantB);
    expect(await worker.outboxEvent.findMany()).toEqual([]);
    expect(await worker.jobDelivery.findMany()).toEqual([]);
    expect(await worker.consumerReceipt.findMany()).toEqual([]);
    expect(await processEvent(worker, { ...ref, tenantId: tenantA })).toBe(
      'missing',
    );
    await expect(
      inTenant(worker, tenantA, (tx) =>
        tx.consumerReceipt.create({ data: { ...ref, consumer: 'forged' } }),
      ),
    ).rejects.toThrow();
    // Even a matching RLS tenant cannot attach a foreign event via a forged tenant ID.
    await expect(
      inTenant(worker, tenantA, (tx) =>
        tx.consumerReceipt.create({
          data: { ...ref, tenantId: tenantA, consumer: 'forged' },
        }),
      ),
    ).rejects.toThrow();
    expect((await delivery(ref)).attempts).toBe(0);
  });

  it('commits one durable receipt across concurrent and later duplicate deliveries', async () => {
    const ref = await activation();
    await Promise.all(
      Array.from({ length: 10 }, () => processEvent(worker, ref)),
    );
    expect(await processEvent(worker, ref)).toBe('completed');
    expect(
      await admin.consumerReceipt.count({ where: { eventId: ref.eventId } }),
    ).toBe(1);
    expect(await delivery(ref)).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    expect(await pending()).not.toContainEqual(ref);
    expect(await worker.consumerReceipt.findMany()).toEqual([]);
  });

  it('rolls back partial handler effects, persists safe failure state and retries once due', async () => {
    const ref = await activation();
    expect(
      await processEvent(worker, ref, async (tx) => {
        await tx.consumerReceipt.create({
          data: { ...ref, consumer: 'partial' },
        });
        throw new Error(
          'Sensitive database/employee details must not be persisted',
        );
      }),
    ).toBe('retry');
    expect(
      await admin.consumerReceipt.count({ where: { eventId: ref.eventId } }),
    ).toBe(0);
    expect(await delivery(ref)).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastError: 'HANDLER_FAILED',
    });
    expect(await processEvent(worker, ref)).toBe('deferred');
    expect((await delivery(ref)).attempts).toBe(1);
    await makeDue(ref);
    expect(await processEvent(worker, ref)).toBe('completed');
    expect((await delivery(ref)).attempts).toBe(2);
  });

  it('recovers from a SQL error inside a handler without committing partial effects', async () => {
    const ref = await activation();
    expect(
      await processEvent(worker, ref, async (tx) => {
        const data = { ...ref, consumer: 'partial' };
        await tx.consumerReceipt.create({ data });
        await tx.consumerReceipt.create({ data });
      }),
    ).toBe('retry');
    expect(
      await admin.consumerReceipt.count({ where: { eventId: ref.eventId } }),
    ).toBe(0);
    expect((await delivery(ref)).attempts).toBe(1);
  });

  it('limits failures to five durable attempts and requires an audited manual replay', async () => {
    const ref = await activation();
    await admin.tenant.update({
      where: { id: tenantA },
      data: { status: 'suspended' },
    });
    for (let i = 1; i <= 5; i++) {
      await makeDue(ref);
      expect(await processEvent(worker, ref)).toBe(i === 5 ? 'dead' : 'retry');
    }
    expect(await processEvent(worker, ref)).toBe('dead');
    expect(await delivery(ref)).toMatchObject({
      attempts: 5,
      lastError: 'TENANT_UNAVAILABLE',
    });
    expect(await pending()).not.toContainEqual(ref);
    const input = {
      ...ref,
      actorId: actor,
      reason: 'Synthetic tenant restored after investigation',
    };
    await expect(replayOutbox(admin, input)).rejects.toThrow(
      'REPLAY_NOT_ALLOWED',
    );
    await admin.tenant.update({
      where: { id: tenantA },
      data: { status: 'active' },
    });
    await expect(replayOutbox(worker, input)).rejects.toThrow();
    expect((await delivery(ref)).status).toBe('dead'); // audit permission failure rolled reset back
    await expect(
      replayOutbox(admin, { ...input, tenantId: tenantB }),
    ).rejects.toThrow('REPLAY_NOT_ALLOWED');
    await expect(
      replayOutbox(admin, { ...input, reason: 'short' }),
    ).rejects.toThrow();
    const results = await Promise.allSettled([
      replayOutbox(admin, input),
      replayOutbox(admin, input),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await admin.auditEvent.count({
        where: {
          resourceId: ref.eventId,
          action: 'outbox.replayed',
          reason: input.reason,
        },
      }),
    ).toBe(1);
    expect(await processEvent(worker, ref)).toBe('completed');
    await expect(replayOutbox(admin, input)).rejects.toThrow(
      'REPLAY_NOT_ALLOWED',
    );
  });

  it('does not acknowledge unsupported events or malformed references', async () => {
    const event = await admin.outboxEvent.create({
      data: {
        tenantId: tenantA,
        type: 'payroll.finalize.v99',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
      },
    });
    const ref = { eventId: event.id, tenantId: tenantA };
    await expect(
      processEvent(worker, { ...ref, salary: 10000 }),
    ).rejects.toThrow();
    expect((await delivery(ref)).attempts).toBe(0);
    expect(await processEvent(worker, ref)).toBe('retry');
    expect((await delivery(ref)).lastError).toBe('UNSUPPORTED_EVENT');
    expect(
      await admin.consumerReceipt.count({ where: { eventId: event.id } }),
    ).toBe(0);
  });

  it('serializes a tenant across workers without blocking another company', async () => {
    const first = await activation();
    const second = await activation();
    const other = await activation(tenantB);
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = processEvent(worker, first, async () => {
      entered();
      await hold;
    });
    try {
      await inside;
      expect(await processEvent(worker, second)).toBe('busy');
      expect((await delivery(second)).attempts).toBe(0);
      expect(await processEvent(worker, other)).toBe('completed');
    } finally {
      release();
      await running;
    }
    expect(await processEvent(worker, second)).toBe('completed');
  });

  it('rebuilds missing Redis jobs from PostgreSQL and survives replay after acknowledgement', async () => {
    runtime = await startWorker({
      ...config,
      WORKER_QUEUE: `kinto-test-${randomUUID()}`,
      WORKER_POLL_MS: 100,
    });
    await runtime.queue.pause();
    const ref = await activation();
    await expect
      .poll(() => runtime!.queue.getJob(ref.eventId), { timeout: 8000 })
      .toBeTruthy();
    const queued = await runtime.queue.getJob(ref.eventId);
    expect(queued?.data).toEqual(ref);
    await queued!.remove(); // simulate losing the queued copy; DB remains authoritative
    await expect
      .poll(() => runtime!.queue.getJob(ref.eventId), { timeout: 8000 })
      .toBeTruthy();
    await runtime.queue.resume();
    await expect
      .poll(async () => (await delivery(ref)).status, { timeout: 8000 })
      .toBe('completed');
    const duplicateId = randomUUID();
    await runtime.queue.add('duplicate', ref, { jobId: duplicateId });
    await expect
      .poll(() => runtime!.queue.getJob(duplicateId), { timeout: 8000 })
      .toBeUndefined();
    expect(
      await admin.consumerReceipt.count({ where: { eventId: ref.eventId } }),
    ).toBe(1);
    expect((await delivery(ref)).attempts).toBe(1);
  });

  it('tracks live workers and excludes expired crash heartbeats without exposing tenant data', async () => {
    runtime = await startWorker({
      ...config,
      WORKER_QUEUE: `kinto-test-${randomUUID()}`,
      WORKER_POLL_MS: 100,
    });
    await expect.poll(() => activeWorkers(runtime!.queue)).toBe(1);
    const instance = randomUUID();
    await publishHeartbeat(runtime.queue, instance, 60000);
    expect(await activeWorkers(runtime.queue)).toBe(2);
    await publishHeartbeat(runtime.queue, instance, -1); // simulate an expired lease after process death
    expect(await activeWorkers(runtime.queue)).toBe(1);
    await removeHeartbeat(runtime.queue, instance);
    const ref = await activation();
    await expect
      .poll(async () => (await delivery(ref)).status)
      .toBe('completed');
    const health = await readHealth(dispatcher, runtime.queue);
    expect(healthAlerts(health)).toEqual([]);
    expect(health.activeWorkers).toBe(1);
  });
});
