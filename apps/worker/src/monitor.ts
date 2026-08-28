import { existsSync } from 'node:fs';
import { Queue } from 'bullmq';
import { createDatabase, assertSafeRuntimeRole } from '@kinto/database';
import { monitorConfig, redisConnection } from './config';
import { readHealth } from './health';
import { startMonitor } from './monitor-server';

if (existsSync('.env')) process.loadEnvFile('.env');
else if (existsSync('../../.env')) process.loadEnvFile('../../.env');

async function main() {
  const config = monitorConfig(process.env);
  const port = config.WORKER_MONITOR_PORT;
  const db = createDatabase(config.DISPATCHER_DATABASE_URL);
  const queue = new Queue(config.WORKER_QUEUE, {
    connection: {
      ...redisConnection(config.REDIS_URL),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  });
  queue.on('error', () => {});
  const server = await startMonitor(async () => {
    await assertSafeRuntimeRole(db);
    return readHealth(db, queue);
  }, port);
  const stop = () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(() => {
      void Promise.all([queue.close(), db.$disconnect()])
        .then(() => clearTimeout(deadline))
        .catch(() => process.exit(1));
    });
    server.closeIdleConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log('Worker monitor listening on loopback');
}
void main().catch(() => {
  console.error('Worker monitor startup failed');
  process.exit(1);
});
