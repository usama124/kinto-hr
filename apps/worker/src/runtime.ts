import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { assertSafeRuntimeRole, createDatabase } from '@kinto/database';
import {
  processEvent,
  referenceSchema,
  type EventReference,
} from './processor';
import { redisConnection, workerConfig } from './config';
import { randomUUID } from 'node:crypto';
import { publishHeartbeat, removeHeartbeat } from './health';

export async function startWorker(config: ReturnType<typeof workerConfig>) {
  const db = createDatabase(config.WORKER_DATABASE_URL);
  const dispatcher = createDatabase(config.DISPATCHER_DATABASE_URL);
  const connection = redisConnection(config.REDIS_URL);
  const queue = new Queue<EventReference>(config.WORKER_QUEUE, {
    connection: {
      ...connection,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  // Never pass an underlying exception to BullMQ: Redis retains failure text.
  const worker = new Worker(
    config.WORKER_QUEUE,
    async (job) => {
      const parsed = referenceSchema.safeParse(job.data);
      if (!parsed.success)
        throw new UnrecoverableError('INVALID_EVENT_REFERENCE');
      try {
        return await processEvent(db, parsed.data);
      } catch {
        throw new Error('PROCESSING_UNAVAILABLE');
      }
    },
    {
      connection: { ...connection, maxRetriesPerRequest: null },
      concurrency: 4,
      autorun: false,
    },
  );
  const log = (event: string) =>
    console.log(JSON.stringify({ service: 'worker', event }));
  queue.on('error', () => log('queue_unavailable'));
  worker.on('error', () => log('worker_unavailable'));
  let timer: NodeJS.Timeout | undefined;
  let closing = false;
  let currentPoll: Promise<void> = Promise.resolve();
  let running: Promise<void> | undefined;
  let lastHeartbeat = 0;
  const instanceId = randomUUID();

  async function dispatch() {
    const refs = await dispatcher.$queryRaw<
      EventReference[]
    >`SELECT * FROM public.pending_outbox(100)`;
    for (const ref of refs) {
      if (closing) break;
      await queue.add('outbox-reference', referenceSchema.parse(ref), {
        jobId: ref.eventId,
      });
    }
  }
  async function poll() {
    try {
      await dispatch();
      if (!closing && worker.isRunning() && !worker.isPaused()) {
        if ((await worker.client).status !== 'ready')
          throw new Error('Worker connection unavailable');
        await publishHeartbeat(
          queue,
          instanceId,
          Math.max(60000, config.WORKER_POLL_MS * 3),
        );
      }
      if (Date.now() - lastHeartbeat >= 30000) {
        log('dispatch_ok');
        lastHeartbeat = Date.now();
      }
    } catch {
      log('dispatch_unavailable');
    }
    if (!closing)
      timer = setTimeout(() => {
        currentPoll = poll();
      }, config.WORKER_POLL_MS);
  }
  async function close() {
    closing = true;
    clearTimeout(timer);
    await currentPoll;
    await removeHeartbeat(queue, instanceId).catch(() =>
      log('heartbeat_cleanup_failed'),
    );
    await worker.close();
    await running;
    await queue.close();
    await Promise.all([db.$disconnect(), dispatcher.$disconnect()]);
  }
  try {
    await Promise.all([
      assertSafeRuntimeRole(db),
      assertSafeRuntimeRole(dispatcher),
    ]);
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
    // Verify actual grants/schema before advertising readiness.
    await dispatcher.$queryRaw`SELECT * FROM public.pending_outbox(1)`;
    await db.jobDelivery.findMany({ take: 1 });
    running = worker.run().catch(() => {
      log('worker_loop_failed');
      process.exitCode = 1;
      void close().catch(() => log('shutdown_failed'));
    });
    currentPoll = poll();
    log('ready');
    return { close, queue };
  } catch {
    await close();
    throw new Error('Worker startup failed');
  }
}
