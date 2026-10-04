import { expect, it } from 'vitest';
import { LocalMachineAuthority } from './local-machine-authority';

it('refuses non-synthetic stores and invalid namespace configuration before connecting', () => {
  const database = 'postgresql://test@127.0.0.1:55432/kinto_test';
  const redis = 'redis://127.0.0.1:56379/2';
  const namespace = '00000000-0000-4000-8000-000000000001';
  for (const [db, store, prefix] of [
    [database.replace('127.0.0.1', 'remote.example'), redis, namespace],
    [database.replace('kinto_test', 'production'), redis, namespace],
    [database, redis.replace('127.0.0.1', 'remote.example'), namespace],
    [database, redis.replace('/2', '/0'), namespace],
    [database, redis.replace('/2', '/1'), namespace],
    [database, redis.replace('redis:', 'rediss:'), namespace],
    [database, redis, 'not-a-uuid'],
  ]) {
    expect(() => new LocalMachineAuthority(db!, store!, prefix!)).toThrow();
  }
});
