import { existsSync } from 'node:fs';
import { Queue } from 'bullmq';
import { assertSafeRuntimeRole, createDatabase } from '@kinto/database';
import { workerConfig, redisConnection } from './config';

if (existsSync('.env')) process.loadEnvFile('.env');
else if (existsSync('../../.env')) process.loadEnvFile('../../.env');
async function check() {
  const deadline = setTimeout(() => {
    console.error('Worker dependency check timed out');
    process.exit(1);
  }, 10000);
  const config = workerConfig(process.env);
  const db = createDatabase(config.DISPATCHER_DATABASE_URL);
  const workerDb = createDatabase(config.WORKER_DATABASE_URL);
  const queue = new Queue(config.WORKER_QUEUE, {
    connection: {
      ...redisConnection(config.REDIS_URL),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  });
  queue.on('error', () => {});
  try {
    await Promise.all([
      assertSafeRuntimeRole(db),
      assertSafeRuntimeRole(workerDb),
    ]);
    await workerDb.jobDelivery.findMany({ take: 1 });
    await queue.waitUntilReady();
    const statuses = await db.$queryRaw<
      { status: string; count: bigint; oldestDueAt: Date }[]
    >`SELECT * FROM public.outbox_health()`;
    console.log(
      JSON.stringify({
        dependencies: 'ready',
        deliveries: statuses.map((row) => ({
          ...row,
          count: Number(row.count),
        })),
      }),
    );
    if (statuses.some((row) => row.status === 'dead' && row.count > 0n))
      process.exitCode = 1;
  } finally {
    await queue.close();
    await db.$disconnect();
    await workerDb.$disconnect();
    clearTimeout(deadline);
  }
}
void check().catch(() => {
  console.error('Worker dependency check failed');
  process.exit(1);
});
