import { parseEnv } from 'node:util';

const loopback = ['localhost', '127.0.0.1', '[::1]'];
export function assertLocalAuthTarget(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV && !['development', 'test'].includes(env.NODE_ENV))
    throw new Error('Local authentication cannot target production');
  const migration = new URL(env.MIGRATION_DATABASE_URL ?? '');
  const runtime = new URL(env.DATABASE_URL ?? '');
  const redis = new URL(env.REDIS_URL ?? '');
  if (
    !loopback.includes(migration.hostname) ||
    !/^\/kinto_test[a-zA-Z0-9_]*$/.test(migration.pathname) ||
    migration.host !== runtime.host ||
    migration.pathname !== runtime.pathname ||
    !['postgresql:', 'postgres:'].includes(migration.protocol) ||
    !['postgresql:', 'postgres:'].includes(runtime.protocol) ||
    migration.username === runtime.username ||
    runtime.username !== 'kinto_app' ||
    !loopback.includes(redis.hostname) ||
    redis.protocol !== 'redis:' ||
    !['', '/', '/0'].includes(redis.pathname) ||
    (env.API_PORT && env.API_PORT !== '4000') ||
    (env.API_HOST && env.API_HOST !== '127.0.0.1')
  )
    throw new Error(
      'Dedicated loopback test database and standard API required',
    );
}

// Preserve unrelated settings/comments, remove duplicate active assignments for
// changed settings, and quote generated values rather than shell-interpolating.
export function updateLocalEnv(source: string, values: Record<string, string>) {
  const remaining = source.split(/\r?\n/).filter((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)?.[1];
    return !key || !(key in values);
  });
  return (
    remaining.join('\n').trimEnd() +
    '\n\n# Persistent local authentication (secrets must stay uncommitted).\n' +
    Object.entries(values)
      .map(([key, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n'\\]/.test(value))
          throw new Error('Invalid local environment setting');
        return `${key}='${value}'`;
      })
      .join('\n') +
    '\n'
  );
}

export function localEnv(source: string) {
  const env = parseEnv(source) as Record<string, string>;
  assertLocalAuthTarget(env);
  return env;
}
