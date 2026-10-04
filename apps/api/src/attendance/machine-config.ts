import { z } from 'zod';

export function readMachineConfig(env: NodeJS.ProcessEnv) {
  const mode = env.CONNECTOR_HTTP_MODE ?? 'disabled';
  if (mode === 'disabled') return undefined;
  if (
    mode !== 'local_test' ||
    env.NODE_ENV === 'production' ||
    (env.API_HOST ?? '127.0.0.1') !== '127.0.0.1'
  )
    throw new Error(
      'Connector HTTP requires local_test mode and a loopback non-production API',
    );
  const databaseUrl = z.url().parse(env.DATABASE_URL);
  const redisUrl = z.url().parse(env.CONNECTOR_REDIS_URL);
  const db = new URL(databaseUrl),
    redis = new URL(redisUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  if (
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    !loopback.includes(db.hostname) ||
    !db.pathname.startsWith('/kinto_test') ||
    redis.protocol !== 'redis:' ||
    !loopback.includes(redis.hostname) ||
    !/^\/(?:[2-9]|1[0-5])$/.test(redis.pathname)
  )
    throw new Error(
      'Connector HTTP requires synthetic loopback databases and separate Redis DB 2–15',
    );
  return {
    databaseUrl,
    redisUrl,
    namespace: z.uuid().parse(env.CONNECTOR_NAMESPACE),
  };
}
