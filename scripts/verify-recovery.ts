import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  activateEmployee,
  assertSafeRuntimeRole,
  createDatabase,
  createEmployeeDraft,
  inTenant,
  inAuthorizedTenant,
  requestCompanyProvisioning,
  reconcileCompanyOwnerProvider,
  markCompanyOwnerInvitationDelivered,
  findActiveIdentity,
  reconcileEmployeeAccountProvider,
  markEmployeeInvitationDelivered,
  requestEmployeeAccountProvisioning,
  updateTenantMembershipRoles,
  type PrismaClient,
} from '@kinto/database';
import { processEvent } from '../apps/worker/src/processor';

if (existsSync('.env')) process.loadEnvFile('.env');
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
function verifyArchive(bytes: Buffer, checksum: string) {
  assert.equal(digest(bytes), checksum, 'Archive checksum mismatch');
}

async function snapshot(db: PrismaClient) {
  // Adding a business table requires extending the restore assertion, not silently skipping it.
  const tables = await db.$queryRaw<
    { name: string }[]
  >`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  assert.deepEqual(
    tables.map((row) => row.name),
    [
      'audit_events',
      'company_provisioning_requests',
      'consumer_receipts',
      'employee_account_requests',
      'employee_identity_links',
      'employee_invitations',
      'employees',
      'identities',
      'job_deliveries',
      'memberships',
      'outbox_events',
      'owner_invitations',
      'platform_audit_events',
      'platform_operators',
      'tenants',
    ],
  );
  return {
    identities: await db.identity.findMany({ orderBy: { id: 'asc' } }),
    platformOperators: await db.platformOperator.findMany({
      orderBy: { identityId: 'asc' },
    }),
    provisioningRequests: await db.companyProvisioningRequest.findMany({
      orderBy: { id: 'asc' },
    }),
    ownerInvitations: await db.ownerInvitation.findMany({
      orderBy: { id: 'asc' },
    }),
    employeeAccountRequests: await db.employeeAccountRequest.findMany({
      orderBy: { id: 'asc' },
    }),
    employeeInvitations: await db.employeeInvitation.findMany({
      orderBy: { id: 'asc' },
    }),
    employeeIdentityLinks: await db.employeeIdentityLink.findMany({
      orderBy: { id: 'asc' },
    }),
    platformAudit: await db.platformAuditEvent.findMany({
      orderBy: { id: 'asc' },
    }),
    memberships: await db.membership.findMany({ orderBy: { id: 'asc' } }),
    tenants: await db.tenant.findMany({ orderBy: { id: 'asc' } }),
    employees: await db.employee.findMany({ orderBy: { id: 'asc' } }),
    audit: await db.auditEvent.findMany({ orderBy: { id: 'asc' } }),
    outbox: await db.outboxEvent.findMany({ orderBy: { id: 'asc' } }),
    deliveries: await db.jobDelivery.findMany({ orderBy: { eventId: 'asc' } }),
    receipts: await db.consumerReceipt.findMany({
      orderBy: { eventId: 'asc' },
    }),
  };
}

async function main() {
  if (process.argv.length !== 2)
    throw new Error('This drill accepts no source/target arguments');
  const keys = [
    'MIGRATION_DATABASE_URL',
    'DATABASE_URL',
    'WORKER_DATABASE_URL',
    'DISPATCHER_DATABASE_URL',
  ] as const;
  const urls = keys.map((key) => new URL(process.env[key] || 'invalid'));
  const base = urls[0];
  if (
    !['localhost', '127.0.0.1'].includes(base.hostname) ||
    !base.pathname.startsWith('/kinto_test') ||
    urls.some(
      (url) =>
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.host !== base.host ||
        url.pathname !== base.pathname,
    )
  )
    throw new Error('Recovery drill requires matching local kinto_test* URLs');
  const container =
    process.env.RECOVERY_POSTGRES_CONTAINER || 'kinto-hr-postgres-1';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container))
    throw new Error('Invalid test container');
  const id = randomUUID().replaceAll('-', '');
  const sourceName = `kinto_test_backup_${id}`;
  const restoredName = `kinto_test_restore_${id}`;
  function envFor(name: string) {
    const env = { ...process.env };
    keys.forEach((key, i) => {
      const url = new URL(urls[i]);
      url.pathname = `/${name}`;
      env[key] = url.toString();
    });
    return env;
  }
  const sourceEnv = envFor(sourceName);
  const restoredEnv = envFor(restoredName);
  const admin = createDatabase(process.env.MIGRATION_DATABASE_URL!);
  const source = createDatabase(sourceEnv.MIGRATION_DATABASE_URL!);
  const sourceApp = createDatabase(sourceEnv.DATABASE_URL!);
  const sourceWorker = createDatabase(sourceEnv.WORKER_DATABASE_URL!);
  const restored = createDatabase(restoredEnv.MIGRATION_DATABASE_URL!);
  const restoredApp = createDatabase(restoredEnv.DATABASE_URL!);
  const restoredWorker = createDatabase(restoredEnv.WORKER_DATABASE_URL!);
  const created: string[] = [];
  const directory = resolve('.local/recovery', id);
  let stage = 'container identity';
  function docker(command: string, args: string[], input?: Buffer) {
    const result = spawnSync(
      'docker',
      ['exec', '-i', container, command, ...args],
      {
        input,
        encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      },
    );
    if (result.status !== 0 || result.error)
      throw new Error(`Recovery ${command} failed`);
    return result.stdout;
  }
  function pnpm(args: string[], env: NodeJS.ProcessEnv) {
    const result = spawnSync('pnpm', args, {
      env,
      stdio: 'inherit',
      timeout: 60000,
    });
    if (result.status !== 0) throw new Error('Recovery setup failed');
  }
  try {
    // Verify Docker and the URL address the same cluster before creating any fixture databases.
    const [identity] = await admin.$queryRaw<
      { id: string }[]
    >`SELECT system_identifier::text AS id FROM pg_control_system()`;
    const dockerIdentity = docker('psql', [
      '--username',
      decodeURIComponent(base.username),
      '--dbname',
      'postgres',
      '-Atc',
      'SELECT system_identifier FROM pg_control_system()',
    ])
      .toString()
      .trim();
    assert.equal(identity.id, dockerIdentity);
    const startedAt = new Date();
    for (const name of [sourceName, restoredName]) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    stage = 'source setup';
    pnpm(['db:migrate'], sourceEnv);
    pnpm(['db:bootstrap'], sourceEnv);
    const tenants = [randomUUID(), randomUUID()];
    const actor = randomUUID();
    const refs: { tenantId: string; eventId: string }[] = [];
    const accountActors: {
      identityId: string;
      membershipId: string;
      employeeId: string;
    }[] = [];
    const membershipOwners: string[] = [];
    for (const tenantId of tenants) {
      await source.tenant.create({
        data: {
          id: tenantId,
          name: 'Synthetic recovery company',
          employeeLimit: 5,
        },
      });
      const employee = await createEmployeeDraft(
        sourceApp,
        tenantId,
        { employeeNumber: 'RESTORE-001', name: 'Synthetic recovery employee' },
        actor,
      );
      await activateEmployee(sourceApp, tenantId, employee.id, 1, actor);
      const event = await source.outboxEvent.findFirstOrThrow({
        where: { tenantId },
      });
      refs.push({ tenantId, eventId: event.id });
      const identity = await source.identity.create({
        data: { issuer: 'https://recovery.example/realm', subject: tenantId },
      });
      const membership = await source.membership.create({
        data: { tenantId, identityId: identity.id, roles: ['hr_admin'] },
      });
      accountActors.push({
        identityId: identity.id,
        membershipId: membership.id,
        employeeId: employee.id,
      });
      const owner = await source.identity.create({
        data: {
          issuer: 'https://recovery.example/realm',
          subject: `owner-${tenantId}`,
        },
      });
      await source.membership.create({
        data: { tenantId, identityId: owner.id, roles: ['owner'] },
      });
      membershipOwners.push(owner.id);
    }
    const accountRequests = [];
    for (const [index, account] of accountActors.entries())
      accountRequests.push(
        await requestEmployeeAccountProvisioning(
          sourceApp,
          { identityId: account.identityId, mfaVerified: true },
          tenants[index],
          account.employeeId,
          randomUUID(),
          { email: `employee-${index}@recovery.example` },
        ),
      );
    await updateTenantMembershipRoles(
      sourceApp,
      { identityId: membershipOwners[0], mfaVerified: true },
      tenants[0],
      accountActors[0].membershipId,
      {
        expectedVersion: 1,
        roles: ['hr_admin', 'payroll_preparer'],
        reason: 'Synthetic recovery membership change',
      },
    );
    const employeeProvider = {
      issuer: 'https://recovery.example/realm',
      subject: 'synthetic-active-employee',
    };
    const employeeExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await reconcileEmployeeAccountProvider(
      sourceApp,
      accountRequests[0].accountRequestId,
      employeeProvider,
      employeeExpiry,
    );
    await markEmployeeInvitationDelivered(
      sourceApp,
      accountRequests[0].accountRequestId,
      employeeExpiry,
    );
    await findActiveIdentity(sourceApp, {
      ...employeeProvider,
      mfaVerified: true,
    });
    assert.equal(await source.employeeIdentityLink.count(), 1);
    const operator = await source.identity.create({
      data: {
        issuer: 'https://recovery.example/realm',
        subject: 'synthetic-platform-operator',
      },
    });
    await source.platformOperator.create({
      data: { identityId: operator.id },
    });
    const provisioning = await requestCompanyProvisioning(
      sourceApp,
      { identityId: operator.id, mfaVerified: true },
      randomUUID(),
      {
        companyName: 'Synthetic pending recovery company',
        employeeLimit: 20,
        billingMode: 'complimentary',
        initialOwnerEmail: 'owner@recovery.example',
      },
    );
    assert.equal(provisioning.status, 'pending_identity_provider');
    const invitationExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await reconcileCompanyOwnerProvider(
      sourceApp,
      provisioning.provisioningRequestId,
      {
        issuer: 'https://recovery.example/realm',
        subject: 'synthetic-pending-owner',
      },
      invitationExpiry,
    );
    await markCompanyOwnerInvitationDelivered(
      sourceApp,
      provisioning.provisioningRequestId,
      invitationExpiry,
    );
    assert.equal(await processEvent(sourceWorker, refs[0]), 'completed');
    const dead = await source.outboxEvent.create({
      data: {
        tenantId: tenants[1],
        type: 'unsupported.fixture.v1',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
      },
    });
    for (let i = 0; i < 5; i++) {
      await source.jobDelivery.update({
        where: { eventId: dead.id },
        data: { availableAt: new Date(0) },
      });
      await processEvent(sourceWorker, {
        eventId: dead.id,
        tenantId: tenants[1],
      });
    }
    const expected = await snapshot(source);
    stage = 'backup';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = docker('pg_dump', [
      '--username',
      decodeURIComponent(base.username),
      '--dbname',
      sourceName,
      '--format=custom',
    ]);
    const checksum = digest(archive);
    const path = join(directory, 'synthetic.dump');
    await writeFile(path, archive, { mode: 0o600 });
    // The source changes after the snapshot; this record must NOT appear in the restore.
    await createEmployeeDraft(
      sourceApp,
      tenants[0],
      { employeeNumber: 'POST-BACKUP', name: 'Synthetic later record' },
      actor,
    );
    const saved = await readFile(path);
    verifyArchive(saved, checksum);
    const corrupted = Buffer.from(saved);
    corrupted[0] ^= 1;
    assert.throws(
      () => verifyArchive(corrupted, checksum),
      /checksum mismatch/,
    );
    stage = 'restore';
    const restoreStarted = performance.now();
    // No --clean/--create: only the empty, generated target may receive this trusted fixture archive.
    docker(
      'pg_restore',
      [
        '--username',
        decodeURIComponent(base.username),
        '--dbname',
        restoredName,
        '--exit-on-error',
        '--single-transaction',
      ],
      saved,
    );
    const restoreMs = Math.round(performance.now() - restoreStarted);
    stage = 'restored invariants';
    assert.deepEqual(await snapshot(restored), expected);
    await Promise.all([
      assertSafeRuntimeRole(restoredApp),
      assertSafeRuntimeRole(restoredWorker),
    ]);
    const policies = await restored.$queryRaw<
      { enabled: boolean; forced: boolean }[]
    >`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r' AND relname <> '_prisma_migrations'`;
    assert.equal(policies.length, 15);
    assert.ok(policies.every((row) => row.enabled && row.forced));
    assert.deepEqual(await restoredApp.employee.findMany(), []);
    for (const tenantId of tenants) {
      const principal = {
        issuer: 'https://recovery.example/realm',
        subject: tenantId,
        mfaVerified: true,
      };
      assert.equal(
        await inAuthorizedTenant(
          restoredApp,
          principal,
          tenantId,
          'employees.read',
          (tx) => tx.employee.count(),
        ),
        1,
      );
      await assert.rejects(
        inAuthorizedTenant(
          restoredApp,
          principal,
          tenants.find((id) => id !== tenantId)!,
          'employees.read',
          async () => true,
        ),
      );
      const employees = await inTenant(restoredApp, tenantId, (tx) =>
        tx.employee.findMany(),
      );
      assert.equal(employees.length, 1);
      assert.equal(employees[0].tenantId, tenantId);
    }
    await assert.rejects(
      inTenant(restoredApp, tenants[0], (tx) =>
        tx.employee.create({
          data: {
            tenantId: tenants[1],
            employeeNumber: 'FORGED',
            name: 'Synthetic forbidden',
          },
        }),
      ),
    );
    assert.equal(await processEvent(restoredWorker, refs[0]), 'completed');
    assert.equal(await restored.consumerReceipt.count(), 1); // completed work is not repeated
    assert.equal(await processEvent(restoredWorker, refs[1]), 'completed');
    assert.equal(await restored.consumerReceipt.count(), 2); // pending work resumes once
    assert.equal(
      await processEvent(restoredWorker, {
        eventId: dead.id,
        tenantId: tenants[1],
      }),
      'dead',
    );
    assert.equal(
      (
        await restored.jobDelivery.findUniqueOrThrow({
          where: { eventId: dead.id },
        })
      ).attempts,
      5,
    );
    pnpm(['db:migrate'], restoredEnv);
    const report = {
      status: 'passed',
      scope:
        'synthetic database restore on existing local cluster; no file storage or PITR',
      startedAt,
      finishedAt: new Date(),
      restoreMs,
      archiveBytes: archive.length,
      archiveSha256: checksum,
      tenants: 2,
      snapshotEmployees: 2,
      completedReplayPreserved: true,
      pendingResumedOnce: true,
      deadPreserved: true,
      pendingCompanyProvisioningPreserved: true,
      pendingEmployeeAccountRequestPreserved: true,
      activeEmployeeIdentityLinkPreserved: true,
      membershipAdministrationAuditPreserved: true,
    };
    await writeFile(
      join(directory, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(
      `Recovery drill passed; private evidence: .local/recovery/${id}/report.json`,
    );
    console.log(JSON.stringify(report));
  } catch {
    throw new Error(`Recovery drill failed at ${stage}`);
  } finally {
    await Promise.all(
      [
        source,
        sourceApp,
        sourceWorker,
        restored,
        restoredApp,
        restoredWorker,
      ].map((db) => db.$disconnect()),
    );
    try {
      for (const name of created)
        await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error &&
      error.message.startsWith('Recovery drill failed at ')
      ? error.message
      : 'Recovery drill refused or failed',
  );
  process.exitCode = 1;
});
