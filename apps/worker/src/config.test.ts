import { describe, expect, it } from 'vitest';
import { workerConfig, redisConnection } from './config';
import { referenceSchema, retryDelay } from './processor';
import { randomUUID } from 'node:crypto';

const env = {
  WORKER_DATABASE_URL:
    'postgresql://kinto_worker:fixture@localhost:5432/kinto_test',
  DISPATCHER_DATABASE_URL:
    'postgresql://kinto_dispatcher:fixture@localhost:5432/kinto_test',
  REDIS_URL: 'redis://localhost:6379/0',
};
describe('worker configuration and queue boundary', () => {
  it('uses bounded defaults and supports TLS/auth/database selection', () => {
    expect(workerConfig(env)).toMatchObject({
      WORKER_QUEUE: 'kinto-foundation',
      WORKER_POLL_MS: 2000,
    });
    expect(
      redisConnection('rediss://service:hello%21@redis.example/2'),
    ).toMatchObject({
      port: 6379,
      username: 'service',
      password: 'hello!',
      db: 2,
      tls: {},
    });
    expect(redisConnection(env.REDIS_URL)).toMatchObject({
      host: 'localhost',
      db: 0,
      tls: undefined,
    });
    expect(redisConnection('redis://localhost')).toMatchObject({
      port: 6379,
      db: 0,
    });
  });
  it('fails safely for missing settings, privileged roles or unrelated databases', () => {
    expect(() => workerConfig({})).toThrow('Invalid worker configuration');
    expect(() =>
      workerConfig({
        ...env,
        WORKER_DATABASE_URL: env.WORKER_DATABASE_URL.replace(
          'kinto_worker',
          'admin',
        ),
      }),
    ).toThrow('Invalid worker configuration');
    expect(() =>
      workerConfig({
        ...env,
        DISPATCHER_DATABASE_URL: env.DISPATCHER_DATABASE_URL.replace(
          'kinto_test',
          'other',
        ),
      }),
    ).toThrow('targets must match');
  });
  it.each([
    'http://localhost/0',
    'redis://localhost/16',
    'redis://localhost/0?secret=1',
  ])('rejects invalid Redis settings %s', (REDIS_URL) => {
    expect(() => workerConfig({ ...env, REDIS_URL })).toThrow(
      'Invalid worker configuration',
    );
  });
  it.each([
    { WORKER_QUEUE: 'other:queue' },
    { WORKER_POLL_MS: '0' },
    { WORKER_POLL_MS: '60001' },
  ])('rejects unsafe queue/poll settings', (override) => {
    expect(() => workerConfig({ ...env, ...override })).toThrow(
      'Invalid worker configuration',
    );
  });
  it('allows references only, rejecting extra sensitive or authoritative fields', () => {
    const ref = { eventId: randomUUID(), tenantId: randomUUID() };
    expect(referenceSchema.parse(ref)).toEqual(ref);
    expect(() => referenceSchema.parse({ ...ref, salary: 1000 })).toThrow();
    expect(() =>
      referenceSchema.parse({ eventId: 'bad', tenantId: ref.tenantId }),
    ).toThrow();
  });
  it('uses exponential delay with bounded jitter', () => {
    expect(retryDelay(1, 0)).toBe(500);
    expect(retryDelay(5, 1)).toBe(16000);
    expect(retryDelay(20, 1)).toBe(60000);
  });
});
