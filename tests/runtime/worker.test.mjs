import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';

if (existsSync('.env')) process.loadEnvFile('.env');

function run(overrides, stopWhenReady = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['apps/worker/dist/main.cjs'], {
      env: {
        ...process.env,
        NODE_PATH: '',
        WORKER_QUEUE: `kinto-runtime-${randomUUID()}`,
        ...overrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let ready = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Built worker did not start/stop within 20 seconds'));
    }, 20000);
    const collect = (chunk) => {
      output += chunk.toString();
      if (!ready && output.includes('"event":"ready"')) {
        ready = true;
        if (stopWhenReady) child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, ready });
    });
  });
}

test('standalone built worker starts with restricted roles and shuts down on SIGTERM', async () => {
  const result = await run({}, true);
  assert.equal(result.ready, true);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.signal, null);
});

test('missing worker configuration fails safely before consuming jobs', async () => {
  const result = await run({
    WORKER_DATABASE_URL: '',
    REDIS_URL: 'secret-marker-do-not-log',
  });
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.equal(result.output.includes('secret-marker-do-not-log'), false);
});

test('unavailable Redis cannot hang startup or advertise readiness', async () => {
  const result = await run({ REDIS_URL: 'redis://127.0.0.1:1/0' });
  assert.equal(result.code, 1);
  assert.equal(result.ready, false);
  assert.equal(result.output.includes('ECONNREFUSED'), false);
});
