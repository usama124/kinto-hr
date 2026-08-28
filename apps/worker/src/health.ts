import type { Queue, IRedisClient } from 'bullmq';
import type { PrismaClient } from '@kinto/database';

const key = (queue: Queue) => queue.toKey('runtime-heartbeats');
const configured = new WeakSet<IRedisClient>();
async function clientFor(queue: Queue) {
  const client = await queue.client;
  if (!configured.has(client)) {
    client.defineCommand('kintoHeartbeatV1', {
      numberOfKeys: 1,
      lua: `
      local clock = redis.call('TIME')
      local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
      redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
      redis.call('PEXPIRE', KEYS[1], 300000)
      return 1`,
    });
    client.defineCommand('kintoActiveWorkersV1', {
      numberOfKeys: 1,
      lua: `
      local clock = redis.call('TIME')
      local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
      return redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf')`,
    });
    client.defineCommand('kintoRemoveHeartbeatV1', {
      numberOfKeys: 1,
      lua: `return redis.call('ZREM', KEYS[1], ARGV[1])`,
    });
    configured.add(client);
  }
  return client;
}

// Redis time avoids disagreeing host clocks. Scores expire even after a crash;
// the key itself is a disposable registry, never business or authorization state.
export async function publishHeartbeat(
  queue: Queue,
  instanceId: string,
  ttlMs: number,
) {
  await (
    await clientFor(queue)
  ).runCommand('kintoHeartbeatV1', [key(queue), instanceId, ttlMs]);
}
export async function removeHeartbeat(queue: Queue, instanceId: string) {
  await (
    await clientFor(queue)
  ).runCommand('kintoRemoveHeartbeatV1', [key(queue), instanceId]);
}
export async function activeWorkers(queue: Queue): Promise<number> {
  return Number(
    await (
      await clientFor(queue)
    ).runCommand('kintoActiveWorkersV1', [key(queue)]),
  );
}

export type HealthSnapshot = {
  dependenciesReady: boolean;
  activeWorkers: number;
  pending: number;
  retry: number;
  dead: number;
  oldestDueSeconds: number;
};

export async function readHealth(
  db: PrismaClient,
  queue: Queue,
): Promise<HealthSnapshot> {
  const [rows, workers, clock] = await Promise.all([
    db.$queryRaw<
      { status: string; count: bigint; oldestDueAt: Date }[]
    >`SELECT * FROM public.outbox_health()`,
    activeWorkers(queue),
    db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`,
  ]);
  const count = (status: string) =>
    Number(rows.find((row) => row.status === status)?.count || 0n);
  const due = rows
    .filter((row) => ['pending', 'retry'].includes(row.status))
    .map((row) => row.oldestDueAt.getTime());
  return {
    dependenciesReady: true,
    activeWorkers: workers,
    pending: count('pending'),
    retry: count('retry'),
    dead: count('dead'),
    oldestDueSeconds: due.length
      ? Math.max(0, (clock[0].now.getTime() - Math.min(...due)) / 1000)
      : 0,
  };
}

export function healthAlerts(
  snapshot: HealthSnapshot,
  maxDueSeconds = 300,
): string[] {
  if (!snapshot.dependenciesReady) return ['dependencies_unavailable'];
  const alerts: string[] = [];
  if (snapshot.activeWorkers === 0) alerts.push('worker_missing');
  if (snapshot.dead > 0) alerts.push('dead_deliveries');
  if (snapshot.oldestDueSeconds >= maxDueSeconds)
    alerts.push('delivery_overdue');
  return alerts;
}

export function prometheusMetrics(snapshot: HealthSnapshot): string {
  const metrics = {
    kinto_worker_dependencies_ready: Number(snapshot.dependenciesReady),
    kinto_worker_active_instances: snapshot.activeWorkers,
    kinto_outbox_pending: snapshot.pending,
    kinto_outbox_retry: snapshot.retry,
    kinto_outbox_dead: snapshot.dead,
    kinto_outbox_oldest_due_seconds: snapshot.oldestDueSeconds,
  };
  return Object.entries(metrics)
    .map(([name, value]) => `# TYPE ${name} gauge\n${name} ${value}\n`)
    .join('');
}

export const unavailableHealth: HealthSnapshot = {
  dependenciesReady: false,
  activeWorkers: 0,
  pending: 0,
  retry: 0,
  dead: 0,
  oldestDueSeconds: 0,
};
