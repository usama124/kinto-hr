import { z } from 'zod';

const databaseUrl = (role: string) =>
  z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.username === role
    );
  });

const schema = z.object({
  WORKER_DATABASE_URL: databaseUrl('kinto_worker'),
  DISPATCHER_DATABASE_URL: databaseUrl('kinto_dispatcher'),
  REDIS_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ['redis:', 'rediss:'].includes(url.protocol) &&
      /^\/(?:[0-9]|1[0-5])?$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  }),
  WORKER_QUEUE: z
    .string()
    .regex(/^kinto-[a-z0-9-]{1,60}$/)
    .default('kinto-foundation'),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60000).default(2000),
});

export function workerConfig(env: NodeJS.ProcessEnv) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error('Invalid worker configuration');
  const config = result.data;
  const worker = new URL(config.WORKER_DATABASE_URL);
  const dispatcher = new URL(config.DISPATCHER_DATABASE_URL);
  if (
    worker.host !== dispatcher.host ||
    worker.pathname !== dispatcher.pathname
  )
    throw new Error('Worker database targets must match');
  return config;
}

const monitorSchema = schema
  .pick({ DISPATCHER_DATABASE_URL: true, REDIS_URL: true, WORKER_QUEUE: true })
  .extend({
    WORKER_MONITOR_PORT: z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .default(9464),
  });
export function monitorConfig(env: NodeJS.ProcessEnv) {
  const result = monitorSchema.safeParse(env);
  if (!result.success) throw new Error('Invalid monitor configuration');
  return result.data;
}

export function redisConnection(value: string) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    tls: url.protocol === 'rediss:' ? {} : undefined,
    connectTimeout: 5000,
  };
}
