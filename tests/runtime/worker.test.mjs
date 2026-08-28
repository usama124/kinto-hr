import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';

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

test('built private monitor detects a live worker and its graceful removal', async (t) => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = {
    ...process.env,
    NODE_PATH: '',
    WORKER_QUEUE: `kinto-monitor-${randomUUID()}`,
    WORKER_MONITOR_PORT: String(port),
    WORKER_POLL_MS: '100',
  };
  function launch(entry, overrides = {}) {
    const child = spawn(process.execPath, [entry], {
      env: { ...env, ...overrides },
      stdio: 'ignore',
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    });
    return child;
  }
  async function until(check) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        if (await check()) return;
      } catch {
        /* server may still be starting */
      }
      await delay(50);
    }
    assert.fail('Expected monitor state was not reached');
  }
  const monitor = launch('apps/worker/dist/monitor.cjs', {
    WORKER_DATABASE_URL: '',
    DATABASE_URL: '',
    MIGRATION_DATABASE_URL: '',
  });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${url}/health/ready`)).status === 503);
  const worker = launch('apps/worker/dist/main.cjs');
  await until(async () => (await fetch(`${url}/health/ready`)).status === 200);
  assert.match(
    await (await fetch(`${url}/metrics`)).text(),
    /kinto_worker_active_instances 1\n/,
  );
  const liveCheck = spawnSync('pnpm', ['worker:check'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(liveCheck.status, 0, liveCheck.stdout + liveCheck.stderr);
  const stopped = once(worker, 'exit');
  worker.kill('SIGTERM');
  assert.deepEqual(await stopped, [0, null]);
  await until(async () => (await fetch(`${url}/health/ready`)).status === 503);
  assert.match(
    await (await fetch(`${url}/metrics`)).text(),
    /kinto_worker_active_instances 0\n/,
  );
  const stoppedCheck = spawnSync('pnpm', ['worker:check'], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(stoppedCheck.status, 1);
  assert.match(stoppedCheck.stdout, /worker_missing/);
  const monitorStopped = once(monitor, 'exit');
  monitor.kill('SIGTERM');
  assert.deepEqual(await monitorStopped, [0, null]);
});
