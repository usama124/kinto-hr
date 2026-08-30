import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createDatabase, inTenant } from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');

async function main() {
  const keys = [
    'MIGRATION_DATABASE_URL',
    'DATABASE_URL',
    'WORKER_DATABASE_URL',
    'DISPATCHER_DATABASE_URL',
  ] as const;
  const original = keys.map((key) => new URL(process.env[key] || 'invalid'));
  const base = original[0];
  if (
    !['localhost', '127.0.0.1'].includes(base.hostname) ||
    !base.pathname.startsWith('/kinto_test') ||
    original.some(
      (url) => url.host !== base.host || url.pathname !== base.pathname,
    )
  )
    throw new Error(
      'Migration verification requires matching local kinto_test* URLs',
    );
  const databaseName = `kinto_test_migration_${randomUUID().replaceAll('-', '')}`;
  const env = { ...process.env };
  keys.forEach((key, index) => {
    const url = original[index];
    url.pathname = `/${databaseName}`;
    env[key] = url.toString();
  });
  const admin = createDatabase(process.env.MIGRATION_DATABASE_URL!);
  const target = createDatabase(env.MIGRATION_DATABASE_URL!);
  const worker = createDatabase(env.WORKER_DATABASE_URL!);
  const folder = await mkdtemp(join(tmpdir(), 'kinto-migrations-'));
  let created = false;
  function run(args: string[]) {
    const result = spawnSync('pnpm', args, {
      env,
      stdio: 'inherit',
      timeout: 60000,
    });
    if (result.status !== 0)
      throw new Error('Migration verification command failed');
  }
  try {
    // This identifier is generated internally, never interpolated from user input.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const prisma = resolve('packages/database/prisma');
    await cp(join(prisma, 'schema.prisma'), join(folder, 'schema.prisma'));
    await cp(
      join(prisma, 'migrations/202608280001_foundation'),
      join(folder, 'migrations/202608280001_foundation'),
      { recursive: true },
    );
    await cp(
      join(prisma, 'migrations/migration_lock.toml'),
      join(folder, 'migrations/migration_lock.toml'),
    );
    run([
      '--filter',
      '@kinto/database',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--schema',
      join(folder, 'schema.prisma'),
    ]);
    const ids = [randomUUID(), randomUUID()];
    const events = [randomUUID(), randomUUID()];
    for (let i = 0; i < ids.length; i++) {
      await target.$executeRaw`INSERT INTO tenants(id, name, employee_limit) VALUES (${ids[i]}::uuid, 'Synthetic migration fixture', 5)`;
      await target.$executeRaw`INSERT INTO outbox_events(id, tenant_id, type, aggregate_id, aggregate_version) VALUES (${events[i]}::uuid, ${ids[i]}::uuid, 'employee.activated.v1', ${randomUUID()}::uuid, 1)`;
    }
    run(['db:migrate']);
    run(['db:bootstrap']);
    env.PLATFORM_BOOTSTRAP_ISSUER = 'https://migration.synthetic.example/realm';
    env.PLATFORM_BOOTSTRAP_SUBJECT = 'synthetic-first-operator';
    env.PLATFORM_BOOTSTRAP_CONFIRM = 'bootstrap-first-platform-operator';
    run(['db:bootstrap:operator']);
    run(['db:bootstrap:operator']);
    run(['db:migrate']);
    assert.equal(await target.platformOperator.count(), 1);
    assert.equal(
      await target.platformAuditEvent.count({
        where: { action: 'platform_operator.bootstrapped' },
      }),
      1,
    );
    assert.equal(await target.jobDelivery.count(), 2);
    for (const id of ids) {
      const rows = await inTenant(worker, id, (tx) =>
        tx.jobDelivery.findMany(),
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tenantId, id);
      assert.equal(rows[0].status, 'pending');
    }
    assert.deepEqual(await worker.jobDelivery.findMany(), []);
    console.log(
      'Clean baseline, upgrade/backfill, migration replay and two-tenant delivery isolation passed.',
    );
  } finally {
    await Promise.all([target.$disconnect(), worker.$disconnect()]);
    if (created)
      await admin.$executeRawUnsafe(
        `DROP DATABASE "${databaseName}" WITH (FORCE)`,
      );
    await admin.$disconnect();
    await rm(folder, { recursive: true, force: true });
  }
}
void main().catch(() => {
  console.error('Isolated migration verification failed');
  process.exitCode = 1;
});
