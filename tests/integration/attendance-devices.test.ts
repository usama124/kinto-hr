import {
  SyntheticAttendanceDelivery,
  SyntheticTransportFailure,
} from '../../scripts/lib/synthetic-attendance-delivery';
import { SyntheticAttendanceQueue } from '../../scripts/lib/synthetic-attendance-queue';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticAttendanceInbox } from '../../apps/api/src/attendance/synthetic-inbox';
import { processEvent } from '../../apps/worker/src/processor';
import type { AttendanceConnectorScope } from '../../apps/api/src/attendance/preflight';
import 'reflect-metadata';
import { LocalConnectorClient } from '../../scripts/lib/local-connector-client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MachineController } from '../../apps/api/src/attendance/machine-controller';
import { MachineService } from '../../apps/api/src/attendance/machine-service';
import { LocalConnectorOwnerController } from '../../apps/api/src/attendance/local-owner-controller';
import { AuthService } from '../../apps/api/src/auth/service';
import { configureHttp } from '../../apps/api/src/http';
import { LocalMachineAuthority } from '../../apps/api/src/attendance/local-machine-authority';
import { AuthStore } from '../../apps/api/src/auth/store';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  readTenantDeviceMappings,
  resolveTenantDeviceMapping,
  createTenantDeviceMapping,
  endTenantDeviceMapping,
  listConnectorCredentials,
  readConnectorCredentialCandidate,
  issueConnectorEnrollment,
  revokeConnectorEnrollment,
  listConnectorEnrollments,
  changeAttendanceAllocation,
  createDatabase,
  readTenantDeviceInventory,
  createTenantDeviceInventory,
  updateTenantDeviceInventory,
  inTenant,
  createTenantBranch,
  createTenantLegalEntity,
  updateTenantBranch,
} from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (
  !adminUrl ||
  !runtimeUrl ||
  [adminUrl, runtimeUrl].some(
    (url) => !new URL(url).pathname.startsWith('/kinto_test'),
  )
)
  throw new Error('Organization tests require synthetic kinto_test databases');

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let identities: Record<'owner' | 'hr' | 'employee' | 'otherOwner', string>;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const legalEntity = {
  legalName: 'Synthetic Private Limited',
  registrationNumber: '0123456',
  taxNumber: '1234567-8',
  provinceCode: 'PK-PB' as const,
  reason: 'Initial legal employer setup',
};
const branch = {
  code: 'LHR-01',
  name: 'Lahore Head Office',
  provinceCode: 'PK-PB' as const,
  reason: 'Initial operating branch',
};

describe('tenant attendance device inventory', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    identities = {
      owner: randomUUID(),
      hr: randomUUID(),
      employee: randomUUID(),
      otherOwner: randomUUID(),
    };
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic organization tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: Object.entries(identities).map(([name, id]) => ({
        id,
        issuer: 'https://organization.synthetic.example/realm',
        subject: `${name}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: identities.owner, roles: ['owner'] },
        { tenantId, identityId: identities.hr, roles: ['hr_admin'] },
        { tenantId, identityId: identities.employee, roles: ['employee'] },
        {
          tenantId: otherTenantId,
          identityId: identities.otherOwner,
          roles: ['owner'],
        },
      ],
    });
  });

  const inboxes: SyntheticAttendanceInbox[] = [];
  afterEach(async () => {
    for (const inbox of inboxes.splice(0)) await inbox.close();
    for (const { machine, store } of machines.splice(0)) {
      let cursor = '0';
      do {
        const page = await store.redis.scan(
          cursor,
          'MATCH',
          machine.prefix + '*',
          'COUNT',
          100,
        );
        cursor = page[0];
        if (page[1].length) await store.redis.unlink(...page[1]);
      } while (cursor !== '0');
      store.close();
      await machine.close();
    }
    const tenants = [tenantId, otherTenantId];
    await admin.syntheticAttendanceBatch.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.syntheticAttendanceTransport.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.syntheticAttendanceEvent.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.deviceMappingReceipt.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.deviceEmployeeMapping.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.connectorCredential.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.connectorEnrollmentToken.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.attendanceAllocation.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.tenantSubscription.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.platformAuditEvent.deleteMany({
      where: { actorId: identities.owner },
    });
    await admin.platformOperator.deleteMany({
      where: { identityId: identities.owner },
    });

    await admin.consumerReceipt.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.jobDelivery.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.outboxEvent.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.auditEvent.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.companyPolicyVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.department.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.designation.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.attendanceDevice.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.branch.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.legalEntity.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employee.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.membership.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.tenant.deleteMany({ where: { id: { in: tenants } } });
    await admin.identity.deleteMany({
      where: { id: { in: Object.values(identities) } },
    });
  });

  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  const setup = async () => {
    await createTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      legalEntity,
    );
    return createTenantBranch(
      runtime,
      actor(identities.owner),
      tenantId,
      branch,
    );
  };
  const input = (branchId: string, code = 'K50-01') => ({
    branchId,
    code,
    name: 'Synthetic entrance',
    model: 'ZKTeco_K50' as const,
    firmware: null,
    sourceTimezone: 'Asia/Karachi' as const,
    reason: 'initial_setup' as const,
  });
  const update = (branchId: string, expectedVersion = 1) => ({
    branchId,
    name: 'Synthetic renamed entrance',
    model: 'ZKTeco_K50' as const,
    firmware: 'synthetic-1',
    sourceTimezone: 'Asia/Karachi' as const,
    expectedVersion,
    status: 'draft' as const,
    reason: 'metadata_correction' as const,
  });

  it('keeps inventory private and rejects cross-tenant branch assignment', async () => {
    const br = await setup();
    const saved = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(br.id),
    );
    await createTenantLegalEntity(
      runtime,
      actor(identities.otherOwner),
      otherTenantId,
      legalEntity,
    );
    const other = await createTenantBranch(
      runtime,
      actor(identities.otherOwner),
      otherTenantId,
      branch,
    );
    await expect(
      createTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        input(other.id, 'CROSS'),
      ),
    ).rejects.toThrow('INVALID_STATE');
    await expect(
      updateTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        saved.id,
        update(other.id),
      ),
    ).rejects.toThrow('INVALID_STATE');
    await expect(
      updateTenantDeviceInventory(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        saved.id,
        update(other.id),
      ),
    ).rejects.toThrow('NOT_FOUND');
    for (const sql of [
      'SELECT * FROM attendance_devices',
      'INSERT INTO attendance_devices(id) VALUES(gen_random_uuid())',
      "UPDATE attendance_devices SET name='bad'",
      'DELETE FROM attendance_devices',
    ])
      await expect(
        inTenant(runtime, tenantId, (tx) => tx.$queryRawUnsafe(sql)),
      ).rejects.toThrow();
    for (const key of ['WORKER_DATABASE_URL', 'DISPATCHER_DATABASE_URL']) {
      const db = createDatabase(process.env[key]!);
      try {
        await expect(
          db.$queryRaw`SELECT * FROM attendance_devices`,
        ).rejects.toThrow();
        await expect(
          db.$queryRaw`SELECT * FROM read_tenant_device_inventory(${identities.owner}::uuid,true,${tenantId}::uuid,25,NULL::uuid)`,
        ).rejects.toThrow();
      } finally {
        await db.$disconnect();
      }
    }
    expect(await admin.attendanceDevice.count({ where: { tenantId } })).toBe(1);
  });

  it('permits fresh owner writes and HR reads while rejecting stale or revoked authorization', async () => {
    const br = await setup();
    for (const caller of [
      actor(identities.hr),
      actor(identities.employee),
      actor(identities.otherOwner),
      actor(identities.owner, false),
    ])
      await expect(
        createTenantDeviceInventory(runtime, caller, tenantId, input(br.id)),
      ).rejects.toThrow('FORBIDDEN');
    const saved = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(br.id),
    );
    expect(
      (
        await readTenantDeviceInventory(
          runtime,
          actor(identities.hr),
          tenantId,
          { limit: 25 },
        )
      ).items[0],
    ).toMatchObject({
      id: saved.id,
      status: 'draft',
      adapterVersion: null,
      sourceIdentityStatus: 'unverified',
      health: 'not_connected',
      lastSyncAt: null,
    });
    for (const caller of [
      actor(identities.employee),
      actor(identities.otherOwner),
      actor(identities.owner, false),
    ])
      await expect(
        readTenantDeviceInventory(runtime, caller, tenantId, { limit: 25 }),
      ).rejects.toThrow('FORBIDDEN');
    await admin.membership.update({
      where: {
        tenantId_identityId: { tenantId, identityId: identities.owner },
      },
      data: { status: 'revoked' },
    });
    await expect(
      updateTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        saved.id,
        update(br.id),
      ),
    ).rejects.toThrow('FORBIDDEN');
    await admin.membership.update({
      where: {
        tenantId_identityId: { tenantId, identityId: identities.owner },
      },
      data: { status: 'active' },
    });
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await expect(
      readTenantDeviceInventory(runtime, actor(identities.owner), tenantId, {
        limit: 25,
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('serializes duplicate creation and stale revisions without partial audit or outbox writes', async () => {
    const br = await setup();
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        createTenantDeviceInventory(
          runtime,
          actor(identities.owner),
          tenantId,
          input(br.id),
        ),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const saved = await admin.attendanceDevice.findFirstOrThrow({
      where: { tenantId },
    });
    const changes = await Promise.allSettled(
      [update(br.id), { ...update(br.id), name: 'Different version' }].map(
        (value) =>
          updateTenantDeviceInventory(
            runtime,
            actor(identities.owner),
            tenantId,
            saved.id,
            value,
          ),
      ),
    );
    expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(changes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await admin.attendanceDevice.findUniqueOrThrow({
          where: { id: saved.id },
        })
      ).version,
    ).toBe(2);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: { startsWith: 'device.' } },
      }),
    ).toBe(2);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'device.inventory_changed.v1' },
      }),
    ).toBe(2);
  });

  it('retires without deleting history or permitting metadata rewrites and code reuse', async () => {
    const br = await setup();
    const saved = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(br.id),
    );
    await updateTenantBranch(
      runtime,
      actor(identities.owner),
      tenantId,
      br.id,
      { ...branch, expectedVersion: 1, status: 'inactive' },
    );
    await expect(
      createTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        input(br.id, 'NEW'),
      ),
    ).rejects.toThrow('INVALID_STATE');
    const retired = {
      ...update(br.id),
      name: 'Synthetic entrance',
      firmware: null,
      status: 'retired' as const,
      reason: 'retire_device' as const,
    };
    await expect(
      updateTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        saved.id,
        { ...retired, name: 'Changed during retirement' },
      ),
    ).rejects.toThrow('INVALID_STATE');
    expect(
      await updateTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        saved.id,
        retired,
      ),
    ).toEqual({ id: saved.id, version: 2 });
    await expect(
      updateTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        saved.id,
        { ...retired, expectedVersion: 2 },
      ),
    ).rejects.toThrow('INVALID_STATE');
    await expect(
      createTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        input(br.id),
      ),
    ).rejects.toThrow('CONFLICT');
    const item = (
      await readTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        { limit: 25 },
      )
    ).items[0];
    expect(item.status).toBe('retired');
    const events = await admin.auditEvent.findMany({
      where: { tenantId, action: { startsWith: 'device.' } },
    });
    expect(events.map((row) => row.reason).sort()).toEqual([
      'initial_setup',
      'retire_device',
    ]);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'device.inventory_changed.v1' },
      }),
    ).toBe(2);
  });

  it('enforces inventory invariants at the database boundary independently of API validation', async () => {
    const br = await setup();
    const invoke = (
      status: string,
      timezone: string,
      reason: string,
    ) => runtime.$queryRaw`SELECT * FROM public.mutate_tenant_device_inventory(
      ${identities.owner}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,NULL::integer,
      ${br.id}::uuid,'DIRECT'::varchar,'Synthetic direct record'::varchar,'ZKTeco_K50'::varchar,NULL::varchar,
      ${timezone}::varchar,${status}::varchar,${reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
    for (const [status, timezone, reason] of [
      ['active', 'Asia/Karachi', 'initial_setup'],
      ['draft', 'UTC', 'initial_setup'],
      ['draft', 'Asia/Karachi', 'private arbitrary reason'],
    ])
      expect(await invoke(status, timezone, reason)).toEqual([
        { outcome: 'invalid_state', resource_id: null, resource_version: null },
      ]);
    expect(await admin.attendanceDevice.count({ where: { tenantId } })).toBe(0);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'device.inventory_changed.v1' },
      }),
    ).toBe(0);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: { startsWith: 'device.' } },
      }),
    ).toBe(0);
    await admin.identity.update({
      where: { id: identities.owner },
      data: { status: 'disabled' },
    });
    await expect(
      createTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        input(br.id),
      ),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('paginates deterministically without exposing other tenant inventory', async () => {
    const br = await setup();
    const saved = await Promise.all(
      ['A', 'B', 'C'].map((code) =>
        createTenantDeviceInventory(
          runtime,
          actor(identities.owner),
          tenantId,
          input(br.id, code),
        ),
      ),
    );
    const one = await readTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      { limit: 2 },
    );
    expect(one.items).toHaveLength(2);
    expect(one.nextCursor).toBe(one.items[1].id);
    const two = await readTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      { limit: 2, afterId: one.nextCursor! },
    );
    expect(two.items).toHaveLength(1);
    expect(two.nextCursor).toBeNull();
    expect([...one.items, ...two.items].map((row) => row.id)).toEqual(
      saved.map((row) => row.id).sort(),
    );
    expect(
      await readTenantDeviceInventory(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        { limit: 25 },
      ),
    ).toEqual({ items: [], nextCursor: null });
  });
  const enrollmentSetup = async (deviceLimit = 2, connectorLimit = 2) => {
    const branchRecord = await setup();
    const first = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(branchRecord.id),
    );
    const second = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(branchRecord.id, 'K50-02'),
    );
    const plan = await admin.planVersion.findFirstOrThrow({
      where: { code: 'free', planVersion: 1 },
    });
    await admin.tenantSubscription.create({
      data: {
        id: randomUUID(),
        tenantId,
        subscriptionVersion: 1,
        planVersionId: plan.id,
        billingMode: 'free',
        employeeLimit: 5,
        reason: 'Synthetic enrollment subscription',
      },
    });
    await admin.platformOperator.create({
      data: { identityId: identities.owner },
    });
    await changeAttendanceAllocation(
      runtime,
      actor(identities.owner),
      tenantId,
      randomUUID(),
      {
        expectedVersion: 0,
        enabled: true,
        deviceLimit,
        connectorLimit,
        reason: 'initial_setup',
      },
    );
    return {
      first,
      second,
      branch: branchRecord,
      input: {
        deviceId: first.id,
        expectedDeviceVersion: 1,
        expectedAllocationVersion: 1,
      },
    };
  };

  it('issues one digest-only enrollment reservation under simultaneous exact retries without replaying secrets', async () => {
    const fixture = await enrollmentSetup();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        issueConnectorEnrollment(
          runtime,
          actor(identities.owner),
          tenantId,
          key,
          fixture.input,
        ),
      ),
    );
    const first = results.find((result) => !result.replayed)!;
    expect(results.filter((result) => result.token !== null)).toHaveLength(1);
    expect(
      results.every((result) => result.enrollment.id === first.enrollment.id),
    ).toBe(true);
    expect(first.machineAccessAvailable).toBe(false);
    const stored = await admin.connectorEnrollmentToken.findUniqueOrThrow({
      where: { id: first.enrollment.id },
    });
    expect(stored.tokenDigest).toBe(
      createHash('sha256').update(first.token!).digest('hex'),
    );
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
      900000,
    );
    expect(JSON.stringify(stored)).not.toContain(first.token!);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'connector.enrollment_issued' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'connector.enrollment_changed.v1' },
      }),
    ).toBe(1);
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        { ...fixture.input, deviceId: fixture.second.id },
      ),
    ).rejects.toThrow('CONFLICT');
    const list = await listConnectorEnrollments(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 25 },
    );
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(stored.tokenDigest);
    expect(JSON.stringify(list)).not.toContain(first.token!);
  });

  it('keeps enrollment digests private and rechecks owner authority on retries', async () => {
    const fixture = await enrollmentSetup();
    const key = randomUUID();
    await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    for (const who of [
      identities.hr,
      identities.employee,
      identities.otherOwner,
    ])
      await expect(
        issueConnectorEnrollment(
          runtime,
          actor(who),
          tenantId,
          randomUUID(),
          fixture.input,
        ),
      ).rejects.toThrow('FORBIDDEN');
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner, false),
        tenantId,
        key,
        fixture.input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    for (const sql of [
      'SELECT * FROM connector_enrollment_tokens',
      "UPDATE connector_enrollment_tokens SET status='revoked'",
      'SELECT enrollment_projection(gen_random_uuid())',
    ])
      await expect(
        inTenant(runtime, tenantId, (db) => db.$queryRawUnsafe(sql)),
      ).rejects.toThrow(/permission denied/);
    const columns = await admin.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.column_privileges WHERE table_name='connector_enrollment_tokens' AND grantee='kinto_control_owner' AND privilege_type='UPDATE' ORDER BY column_name`;
    expect(columns.map((row) => row.column_name)).toEqual([
      'generation_digest',
      'redeemed_at',
      'revoked_at',
      'status',
      'version',
    ]);
    await admin.membership.updateMany({
      where: { tenantId, identityId: identities.owner },
      data: { status: 'revoked' },
    });
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        fixture.input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      listConnectorEnrollments(runtime, actor(identities.employee), tenantId, {
        limit: 25,
      }),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('serializes final connector or device capacity and refuses allocation reductions beneath live reservations', async () => {
    const branchRecord = await setup();
    for (const limits of [
      [2, 1],
      [1, 2],
    ]) {
      // Each iteration releases its previous reservations before changing limits.
      const code = 'CAP-' + limits.join('-');
      const first = await createTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        input(branchRecord.id, code + 'A'),
      );
      const second = await createTenantDeviceInventory(
        runtime,
        actor(identities.owner),
        tenantId,
        input(branchRecord.id, code + 'B'),
      );
      if (limits[0] === 2) {
        const plan = await admin.planVersion.findFirstOrThrow({
          where: { code: 'free', planVersion: 1 },
        });
        await admin.tenantSubscription.create({
          data: {
            id: randomUUID(),
            tenantId,
            subscriptionVersion: 1,
            planVersionId: plan.id,
            billingMode: 'free',
            employeeLimit: 5,
            reason: 'Synthetic quota race',
          },
        });
        await admin.platformOperator.create({
          data: { identityId: identities.owner },
        });
      }
      const version = limits[0] === 2 ? 0 : 1;
      await changeAttendanceAllocation(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        {
          expectedVersion: version,
          enabled: true,
          deviceLimit: limits[0],
          connectorLimit: limits[1],
          reason: version === 0 ? 'initial_setup' : 'allocation_change',
        },
      );
      const results = await Promise.allSettled(
        [first, second].map((device) =>
          issueConnectorEnrollment(
            runtime,
            actor(identities.owner),
            tenantId,
            randomUUID(),
            {
              deviceId: device.id,
              expectedDeviceVersion: 1,
              expectedAllocationVersion: version + 1,
            },
          ),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const winner = results.find((result) => result.status === 'fulfilled')!;
      if (winner.status !== 'fulfilled') throw new Error('Missing winner');
      await expect(
        changeAttendanceAllocation(
          runtime,
          actor(identities.owner),
          tenantId,
          randomUUID(),
          {
            expectedVersion: version + 1,
            enabled: false,
            deviceLimit: 0,
            connectorLimit: 0,
            reason: 'disable_attendance',
          },
        ),
      ).rejects.toThrow('CONFLICT');
      await revokeConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        winner.value.enrollment.id,
        { expectedVersion: 1 },
      );
    }
  });

  it('revokes once, releases capacity, preserves old receipts and never restores a token', async () => {
    const fixture = await enrollmentSetup(1, 1);
    const key = randomUUID();
    const issued = await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      revokeConnectorEnrollment(
        runtime,
        actor(identities.hr),
        tenantId,
        issued.enrollment.id,
        { expectedVersion: 1 },
      ),
    ).rejects.toThrow('FORBIDDEN');
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        revokeConnectorEnrollment(
          runtime,
          actor(identities.owner),
          tenantId,
          issued.enrollment.id,
          { expectedVersion: 1 },
        ),
      ),
    );
    expect(
      results.every(
        (result) => result.status === 'revoked' && result.version === 2,
      ),
    ).toBe(true);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'connector.enrollment_revoked' },
      }),
    ).toBe(1);
    const retry = await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    expect(retry).toMatchObject({
      token: null,
      replayed: true,
      enrollment: { status: 'revoked', version: 2 },
    });
    await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      randomUUID(),
      { ...fixture.input, deviceId: fixture.second.id },
    );
    const list = await listConnectorEnrollments(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 1 },
    );
    expect(list.items).toHaveLength(1);
    expect(list.nextCursor).toBe(list.items[0].id);
    const next = await listConnectorEnrollments(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 1, afterId: list.nextCursor! },
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(list.items[0].id);
    expect(next.nextCursor).toBeNull();
  });

  it('expires reservations without extending retries and refuses stale, inactive or foreign device scope', async () => {
    const fixture = await enrollmentSetup(1, 1);
    const key = randomUUID();
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        { ...fixture.input, expectedAllocationVersion: 2 },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        { ...fixture.input, expectedDeviceVersion: 2 },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        { ...fixture.input, deviceId: randomUUID() },
      ),
    ).rejects.toThrow('NOT_FOUND');
    const issued = await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    // Migration-role-only synthetic time travel; preserve the exact 15-minute lifetime.
    await admin.$executeRaw`UPDATE connector_enrollment_tokens SET created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' WHERE id=${issued.enrollment.id}::uuid`;
    expect(
      await issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        fixture.input,
      ),
    ).toMatchObject({
      token: null,
      replayed: true,
      enrollment: { status: 'expired' },
    });
    await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        fixture.input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      revokeConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        issued.enrollment.id,
        { expectedVersion: 1 },
      ),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('serializes enrollment issuance against allocation disable and rejects invalid direct SQL input', async () => {
    const fixture = await enrollmentSetup(1, 1);
    const results = await Promise.allSettled([
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      ),
      changeAttendanceAllocation(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        {
          expectedVersion: 1,
          enabled: false,
          deviceLimit: 0,
          connectorLimit: 0,
          reason: 'disable_attendance',
        },
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    for (const [version, digest] of [
      [null, 'a'.repeat(64)],
      [0, 'a'.repeat(64)],
      [1, 'not-a-digest'],
    ] as const) {
      const rows = await runtime.$queryRaw<
        { outcome: string }[]
      >`SELECT * FROM issue_connector_enrollment(${identities.owner}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,${fixture.first.id}::uuid,${version}::integer,1,${digest}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
      expect(rows[0].outcome).toBe('invalid_state');
    }
  });

  it('rejects retired devices and inactive branches before creating any reservation', async () => {
    const fixture = await enrollmentSetup();
    await updateTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      fixture.first.id,
      {
        ...update(fixture.branch.id),
        name: 'Synthetic entrance',
        firmware: null,
        status: 'retired',
        reason: 'retire_device',
      },
    );
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      ),
    ).rejects.toThrow('INVALID_STATE');
    await admin.branch.update({
      where: { id: fixture.branch.id },
      data: { status: 'inactive' },
    });
    await expect(
      issueConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        { ...fixture.input, deviceId: fixture.second.id },
      ),
    ).rejects.toThrow('INVALID_STATE');
    expect(
      await admin.connectorEnrollmentToken.count({ where: { tenantId } }),
    ).toBe(0);
  });
  it('rolls back a failed enrollment audit and denies worker or cross-tenant access', async () => {
    const fixture = await enrollmentSetup();
    const duplicateAudit = await admin.auditEvent.findFirstOrThrow({
      where: { tenantId },
    });
    const before = await admin.outboxEvent.count({ where: { tenantId } });
    await expect(
      runtime.$queryRaw`SELECT * FROM issue_connector_enrollment(${identities.owner}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,${fixture.first.id}::uuid,1,1,${'a'.repeat(64)}::varchar,${duplicateAudit.id}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow(/23505/);
    expect(
      await admin.connectorEnrollmentToken.count({ where: { tenantId } }),
    ).toBe(0);
    expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(before);
    const issued = await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    const other = await listConnectorEnrollments(
      runtime,
      actor(identities.otherOwner),
      otherTenantId,
      { limit: 25 },
    );
    expect(other.items).toHaveLength(0);
    await expect(
      revokeConnectorEnrollment(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        issued.enrollment.id,
        { expectedVersion: 1 },
      ),
    ).rejects.toThrow('NOT_FOUND');
    for (const url of [
      process.env.WORKER_DATABASE_URL,
      process.env.DISPATCHER_DATABASE_URL,
    ]) {
      if (!url || !new URL(url).pathname.startsWith('/kinto_test'))
        throw new Error('Synthetic worker/dispatcher URL required');
      const restricted = createDatabase(url);
      try {
        await expect(
          restricted.$queryRaw`SELECT * FROM connector_enrollment_tokens`,
        ).rejects.toThrow(/permission denied/);
        await expect(
          restricted.$queryRaw`SELECT enrollment_projection(${issued.enrollment.id}::uuid)`,
        ).rejects.toThrow(/permission denied/);
      } finally {
        await restricted.$disconnect();
      }
    }
  });
  const machines: { machine: LocalMachineAuthority; store: AuthStore }[] = [];
  const machineSetup = async () => {
    const redisUrl = new URL(process.env.REDIS_URL!);
    redisUrl.pathname = '/2';
    const namespace = randomUUID();
    const machine = new LocalMachineAuthority(
      runtimeUrl!,
      redisUrl.toString(),
      namespace,
    );
    const store = new AuthStore(redisUrl.toString());
    await machine.connect();
    await store.connect();
    machines.push({ machine, store });
    return { machine, store, redisUrl: redisUrl.toString(), namespace };
  };

  it('admits only digest-backed credentials with external permits and preserves revocation across stale database rows', async () => {
    const fixture = await enrollmentSetup(1, 1);
    const { machine, store } = await machineSetup();
    const key = randomUUID();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    const result = await machine.redeem(issued.token!);
    expect(await machine.authorize(result.credential)).toEqual(
      result.connector,
    );
    expect(result.connector).toMatchObject({
      tenantId,
      deviceId: fixture.first.id,
      scope: 'heartbeat_only',
      attendanceIngestionAvailable: false,
    });
    const stored = await admin.connectorCredential.findUniqueOrThrow({
      where: { id: result.connector.id },
    });
    expect(stored.credentialDigest).toBe(
      createHash('sha256').update(result.credential).digest('hex'),
    );
    expect(JSON.stringify(stored)).not.toContain(result.credential);
    const replay = await machine.issue(
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    expect(replay).toMatchObject({
      token: null,
      replayed: true,
      enrollment: { status: 'redeemed', connectorId: result.connector.id },
    });
    await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
    await expect(machine.authorize('kc1_' + 'x'.repeat(43))).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(
      machine.revokeCredential(actor(identities.hr), tenantId, stored.id),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      machine.revokeCredential(
        actor(identities.owner, false),
        tenantId,
        stored.id,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      machine.revokeCredential(
        actor(identities.otherOwner),
        otherTenantId,
        stored.id,
      ),
    ).rejects.toThrow('NOT_FOUND');
    expect(await machine.authorize(result.credential)).toEqual(
      result.connector,
    );
    expect(
      await machine.revokeCredential(
        actor(identities.owner),
        tenantId,
        stored.id,
      ),
    ).toMatchObject({ status: 'revoked', version: 2 });
    await machine.revokeCredential(
      actor(identities.owner),
      tenantId,
      stored.id,
    );
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'connector.revoked' },
      }),
    ).toBe(1);
    // A delayed post-commit grant cannot replace the external revocation tombstone.
    expect(
      await store.redis.set(
        machine.prefix + 'permit:' + stored.id,
        stored.generationDigest + ':' + stored.credentialDigest,
        'EX',
        900,
        'NX',
      ),
    ).toBeNull();
    // Simulate an old PostgreSQL backup: the SQL candidate exists, but it is NOT admission.
    await admin.connectorCredential.update({
      where: { id: stored.id },
      data: { status: 'active', version: 1, revokedAt: null },
    });
    expect(
      await readConnectorCredentialCandidate(
        runtime,
        result.credential,
        stored.generationDigest,
      ),
    ).toEqual(result.connector);
    await expect(machine.authorize(result.credential)).rejects.toThrow(
      'FORBIDDEN',
    );
    expect(
      await listConnectorCredentials(runtime, actor(identities.hr), tenantId, {
        limit: 25,
      }),
    ).toEqual({ items: [result.connector], nextCursor: null });
  });

  it('never revives a consumed enrollment from an older database snapshot or re-discloses a lost response', async () => {
    const fixture = await enrollmentSetup();
    const { machine } = await machineSetup();
    const key = randomUUID();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      key,
      fixture.input,
    );
    await machine.redeem(issued.token!);
    await admin.connectorCredential.deleteMany({ where: { tenantId } });
    await admin.connectorEnrollmentToken.update({
      where: { id: issued.enrollment.id },
      data: { status: 'issued', version: 1, redeemedAt: null },
    });
    await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
    expect(
      (
        await machine.issue(
          actor(identities.owner),
          tenantId,
          key,
          fixture.input,
        )
      ).token,
    ).toBeNull();
    expect(await admin.connectorCredential.count({ where: { tenantId } })).toBe(
      0,
    );
  });

  it('serializes competing redemption and retains device and connector capacity until revocation', async () => {
    const fixture = await enrollmentSetup(1, 1);
    const { machine, redisUrl, namespace } = await machineSetup();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    const peer = new LocalMachineAuthority(runtimeUrl!, redisUrl, namespace);
    await peer.connect();
    let results;
    try {
      results = await Promise.allSettled([
        machine.redeem(issued.token!),
        peer.redeem(issued.token!),
      ]);
    } finally {
      await peer.close();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled')
      throw new Error('Missing redemption winner');
    await expect(
      machine.issue(
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      machine.issue(actor(identities.owner), tenantId, randomUUID(), {
        ...fixture.input,
        deviceId: fixture.second.id,
      }),
    ).rejects.toThrow('CAPACITY_REACHED');
    await expect(
      changeAttendanceAllocation(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        {
          expectedVersion: 1,
          enabled: false,
          deviceLimit: 0,
          connectorLimit: 0,
          reason: 'disable_attendance',
        },
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      machine.revokeEnrollment(
        actor(identities.owner),
        tenantId,
        issued.enrollment.id,
      ),
    ).rejects.toThrow('INVALID_STATE');
    await machine.revokeCredential(
      actor(identities.owner),
      tenantId,
      winner.value.connector.id,
    );
    expect(
      (
        await machine.issue(
          actor(identities.owner),
          tenantId,
          randomUUID(),
          fixture.input,
        )
      ).token,
    ).not.toBeNull();
  });

  it('fails closed after admission state loss and never recreates permits from database rows', async () => {
    const fixture = await enrollmentSetup();
    const { machine, store } = await machineSetup();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    const redeemed = await machine.redeem(issued.token!);
    const pending = await machine.issue(
      actor(identities.owner),
      tenantId,
      randomUUID(),
      { ...fixture.input, deviceId: fixture.second.id },
    );
    await store.redis.del(machine.prefix + 'permit:' + redeemed.connector.id);
    await expect(machine.authorize(redeemed.credential)).rejects.toThrow(
      'FORBIDDEN',
    );
    await store.redis.del(machine.prefix + 'generation');
    await expect(machine.authorize(redeemed.credential)).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(machine.redeem(pending.token!)).rejects.toThrow('FORBIDDEN');
    expect(await admin.connectorCredential.count({ where: { tenantId } })).toBe(
      1,
    );
    // Redis outage is an error, not an SQL-only authorization fallback.
    await machine.close();
    await expect(machine.authorize(redeemed.credential)).rejects.toThrow();
  });

  it('seals bound revocation outside backups and denies the legacy SQL-only revoke path', async () => {
    const fixture = await enrollmentSetup();
    const { machine } = await machineSetup();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    await expect(
      revokeConnectorEnrollment(
        runtime,
        actor(identities.owner),
        tenantId,
        issued.enrollment.id,
        { expectedVersion: 1 },
      ),
    ).rejects.toThrow('INVALID_STATE');
    await machine.revokeEnrollment(
      actor(identities.owner),
      tenantId,
      issued.enrollment.id,
    );
    await admin.connectorEnrollmentToken.update({
      where: { id: issued.enrollment.id },
      data: { status: 'issued', version: 1, revokedAt: null },
    });
    await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
    const legacy = await issueConnectorEnrollment(
      runtime,
      actor(identities.owner),
      tenantId,
      randomUUID(),
      { ...fixture.input, deviceId: fixture.second.id },
    );
    await expect(machine.redeem(legacy.token!)).rejects.toThrow('FORBIDDEN');
  });

  it.each([
    'issuer',
    'company',
    'subscription',
    'allocation',
    'device',
    'branch',
    'expiry',
  ] as const)(
    'rechecks %s authority before redemption and burns failed attempts',
    async (change) => {
      const fixture = await enrollmentSetup();
      const { machine } = await machineSetup();
      const issued = await machine.issue(
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      );
      if (change === 'issuer')
        await admin.membership.updateMany({
          where: { tenantId, identityId: identities.owner },
          data: { status: 'revoked' },
        });
      if (change === 'company')
        await admin.tenant.update({
          where: { id: tenantId },
          data: { status: 'suspended' },
        });
      if (change === 'subscription')
        await admin.tenantSubscription.updateMany({
          where: { tenantId },
          data: { status: 'ended', endedAt: new Date() },
        });
      if (change === 'allocation')
        await changeAttendanceAllocation(
          runtime,
          actor(identities.owner),
          tenantId,
          randomUUID(),
          {
            expectedVersion: 1,
            enabled: true,
            deviceLimit: 3,
            connectorLimit: 2,
            reason: 'allocation_change',
          },
        );
      if (change === 'device')
        await admin.attendanceDevice.update({
          where: { id: fixture.first.id },
          data: { version: 2 },
        });
      if (change === 'branch')
        await admin.branch.update({
          where: { id: fixture.branch.id },
          data: { status: 'inactive' },
        });
      if (change === 'expiry') {
        const createdAt = new Date(Date.now() - 1200000);
        await admin.connectorEnrollmentToken.update({
          where: { id: issued.enrollment.id },
          data: {
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 900000),
          },
        });
      }
      await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
      if (change === 'issuer')
        await admin.membership.updateMany({
          where: { tenantId, identityId: identities.owner },
          data: { status: 'active' },
        });
      if (change === 'company')
        await admin.tenant.update({
          where: { id: tenantId },
          data: { status: 'active' },
        });
      await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
      expect(
        await admin.connectorCredential.count({ where: { tenantId } }),
      ).toBe(0);
    },
  );

  it('rolls back failed redemption audit writes and isolates all credential storage from runtime roles', async () => {
    const fixture = await enrollmentSetup();
    const { machine } = await machineSetup();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    const stored = await admin.connectorEnrollmentToken.findUniqueOrThrow({
      where: { id: issued.enrollment.id },
    });
    const duplicateAudit = await admin.auditEvent.findFirstOrThrow({
      where: { tenantId },
    });
    const before = await admin.outboxEvent.count({ where: { tenantId } });
    await expect(
      runtime.$queryRaw`SELECT * FROM redeem_connector_enrollment(${stored.tokenDigest}::varchar,${stored.generationDigest}::varchar,${randomUUID()}::uuid,${'b'.repeat(64)}::varchar,${duplicateAudit.id}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow(/23505/);
    expect(await admin.connectorCredential.count({ where: { tenantId } })).toBe(
      0,
    );
    expect(
      (
        await admin.connectorEnrollmentToken.findUniqueOrThrow({
          where: { id: stored.id },
        })
      ).status,
    ).toBe('issued');
    expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(before);
    const redeemed = await machine.redeem(issued.token!);
    for (const url of [
      runtimeUrl,
      process.env.WORKER_DATABASE_URL,
      process.env.DISPATCHER_DATABASE_URL,
    ]) {
      if (!url || !new URL(url).pathname.startsWith('/kinto_test'))
        throw new Error('Synthetic database required');
      const restricted = createDatabase(url);
      try {
        await expect(restricted.connectorCredential.findMany()).rejects.toThrow(
          /permission denied/,
        );
        await expect(
          restricted.$queryRaw`SELECT connector_projection(${redeemed.connector.id}::uuid)`,
        ).rejects.toThrow(/permission denied/);
      } finally {
        await restricted.$disconnect();
      }
    }
    await expect(
      listConnectorCredentials(runtime, actor(identities.employee), tenantId, {
        limit: 25,
      }),
    ).rejects.toThrow('FORBIDDEN');
    expect(
      (
        await listConnectorCredentials(
          runtime,
          actor(identities.otherOwner),
          otherTenantId,
          { limit: 25 },
        )
      ).items,
    ).toEqual([]);
    const publicData = JSON.stringify(
      await listConnectorCredentials(runtime, actor(identities.hr), tenantId, {
        limit: 25,
      }),
    );
    expect(publicData).not.toContain(redeemed.credential);
    expect(publicData).not.toContain(stored.generationDigest);
  });
  it('does not expose a credential when its post-commit permit loses a revocation race', async () => {
    const fixture = await enrollmentSetup();
    const { machine, store } = await machineSetup();
    const issued = await machine.issue(
      actor(identities.owner),
      tenantId,
      randomUUID(),
      fixture.input,
    );
    const redis = machine['store'].redis;
    const original = redis.set.bind(redis);
    const intercepted = vi
      .spyOn(redis, 'set')
      .mockImplementation(async (...args) => {
        if (String(args[0]).startsWith(machine.prefix + 'permit:'))
          await store.redis.set(String(args[0]), 'revoked', 'EX', 2592000);
        return Reflect.apply(original, redis, args);
      });
    try {
      await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
    } finally {
      intercepted.mockRestore();
    }
    const row = await admin.connectorCredential.findFirstOrThrow({
      where: { tenantId },
    });
    expect(row.status).toBe('active');
    expect(await store.redis.get(machine.prefix + 'permit:' + row.id)).toBe(
      'revoked',
    );
    await expect(machine.redeem(issued.token!)).rejects.toThrow('FORBIDDEN');
    await machine.revokeCredential(actor(identities.owner), tenantId, row.id);
    expect(
      (
        await machine.issue(
          actor(identities.owner),
          tenantId,
          randomUUID(),
          fixture.input,
        )
      ).token,
    ).not.toBeNull();
  });

  it.each(['company', 'subscription', 'device', 'branch', 'expiry'] as const)(
    'rechecks %s on each credential authorization',
    async (change) => {
      const fixture = await enrollmentSetup();
      const { machine } = await machineSetup();
      const issued = await machine.issue(
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      );
      const result = await machine.redeem(issued.token!);
      if (change === 'company')
        await admin.tenant.update({
          where: { id: tenantId },
          data: { status: 'suspended' },
        });
      if (change === 'subscription')
        await admin.tenantSubscription.updateMany({
          where: { tenantId },
          data: { status: 'ended', endedAt: new Date() },
        });
      if (change === 'device')
        await admin.attendanceDevice.update({
          where: { id: fixture.first.id },
          data: { version: 2 },
        });
      if (change === 'branch')
        await admin.branch.update({
          where: { id: fixture.branch.id },
          data: { status: 'inactive' },
        });
      if (change === 'expiry') {
        const createdAt = new Date(Date.now() - 2678400000);
        await admin.connectorCredential.update({
          where: { id: result.connector.id },
          data: {
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 2592000000),
          },
        });
      }
      await expect(machine.authorize(result.credential)).rejects.toThrow(
        'FORBIDDEN',
      );
    },
  );
  it('runs the gated local HTTP lifecycle with real admission state and SQL permissions', async () => {
    const fixture = await enrollmentSetup();
    const { machine, redisUrl, namespace } = await machineSetup();
    vi.stubEnv('CONNECTOR_HTTP_MODE', 'local_test');
    vi.stubEnv('CONNECTOR_REDIS_URL', redisUrl);
    vi.stubEnv('CONNECTOR_NAMESPACE', namespace);
    vi.stubEnv('API_HOST', '127.0.0.1');
    vi.stubEnv('NODE_ENV', 'test');
    const service = new MachineService();
    const csrf = 'c'.repeat(43),
      origin = 'https://local.synthetic.example';
    let identityId = identities.owner;
    const module = await Test.createTestingModule({
      controllers: [MachineController, LocalConnectorOwnerController],
      providers: [
        { provide: MachineService, useValue: service },
        {
          provide: AuthService,
          useValue: {
            limit: async () => {},
            origin: () => origin,
            session: async () => ({
              identityId,
              selectedTenantId: tenantId,
              csrf,
              authTime: Math.floor(Date.now() / 1000),
              principal: { mfaVerified: true },
            }),
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    configureHttp(app);
    try {
      await app.listen(0, '127.0.0.1');
      await service.ready();
      const owner = `/api/v1/tenants/${tenantId}/local-connectors`,
        machinePath = '/api/v1/local-machine/connectors';
      const issue = await request(app.getHttpServer())
        .post(owner + '/enrollment-tokens')
        .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', randomUUID())
        .send(fixture.input)
        .expect(201);
      const redeemed = await request(app.getHttpServer())
        .post(machinePath + '/redemption')
        .send({ token: issue.body.token })
        .expect(201);
      const credential = redeemed.body.credential as string;
      await request(app.getHttpServer())
        .post(machinePath + '/redemption')
        .send({ token: issue.body.token })
        .expect(403);
      const heartbeat = () =>
        request(app.getHttpServer())
          .post(machinePath + '/heartbeat')
          .set('Authorization', 'Bearer ' + credential)
          .send({});
      expect((await heartbeat().expect(200)).body.connector.id).toBe(
        redeemed.body.connector.id,
      );
      expect(await machine.authorize(credential)).toMatchObject({ tenantId });
      identityId = identities.hr;
      const metadata = await request(app.getHttpServer())
        .get(owner + '/credentials')
        .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
        .expect(200);
      expect(metadata.body.items).toHaveLength(1);
      expect(JSON.stringify(metadata.body)).not.toContain(credential);
      const revoke = () =>
        request(app.getHttpServer())
          .post(
            owner +
              '/credentials/' +
              redeemed.body.connector.id +
              '/revocation',
          )
          .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .send({ expectedVersion: 1 });
      await revoke().expect(403);
      await heartbeat().expect(200);
      identityId = identities.owner;
      await revoke().expect(201);
      await heartbeat().expect(403);
      const next = await machine.issue(
        actor(identities.owner),
        tenantId,
        randomUUID(),
        fixture.input,
      );
      const client = new LocalConnectorClient({
        mode: 'local_test',
        baseUrl: await app.getUrl(),
        binding: {
          tenantId,
          deviceId: fixture.first.id,
          enrollmentId: next.enrollment.id,
        },
      });
      try {
        await client.redeem(next.token!);
        await client.heartbeat();
        expect(client.state).toBe('active');
        await machine.revokeCredential(
          actor(identities.owner),
          tenantId,
          client.connector!.id,
        );
        await expect(client.heartbeat()).rejects.toThrow(
          'Heartbeat not confirmed',
        );
        expect(client.state).toBe('denied');
      } finally {
        client.stop();
      }
      await service.onModuleDestroy();
      await heartbeat().expect(503);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  const mappingSetup = async () => {
    const branch = await setup();
    const first = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(branch.id, 'MAP-01'),
    );
    const second = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(branch.id, 'MAP-02'),
    );
    const employee = await admin.employee.create({
      data: {
        tenantId,
        employeeNumber: 'MAP-01',
        name: 'Synthetic mapping employee',
      },
    });
    const replacement = await admin.employee.create({
      data: {
        tenantId,
        employeeNumber: 'MAP-02',
        name: 'Synthetic replacement employee',
      },
    });
    const foreign = await admin.employee.create({
      data: {
        tenantId: otherTenantId,
        employeeNumber: 'MAP-03',
        name: 'Synthetic other tenant',
      },
    });
    const mapping = {
      employeeId: employee.id,
      sourceUserId: '0007',
      effectiveFrom: '2026-10-01T00:00:00Z',
      effectiveUntil: null,
      reason: 'initial_mapping' as const,
    };
    return { branch, first, second, employee, replacement, foreign, mapping };
  };
  it('keeps device mappings and receipts private behind constrained functions', async () => {
    const f = await mappingSetup();
    await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      f.mapping,
    );
    for (const method of [
      () => runtime.deviceEmployeeMapping.findMany(),
      () => runtime.deviceMappingReceipt.findMany(),
      () =>
        inTenant(runtime, tenantId, (tx) =>
          tx.deviceEmployeeMapping.findMany(),
        ),
    ])
      await expect(method()).rejects.toThrow(/permission denied/);
    for (const inputActor of [
      actor(identities.employee),
      actor(identities.otherOwner),
      actor(identities.owner, false),
    ]) {
      await expect(
        readTenantDeviceMappings(runtime, inputActor, tenantId, f.first.id, {
          limit: 25,
        }),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        resolveTenantDeviceMapping(runtime, inputActor, tenantId, f.first.id, {
          sourceUserId: '0007',
          at: '2026-10-02T00:00:00Z',
        }),
      ).rejects.toThrow('FORBIDDEN');
    }
    const listed = await readTenantDeviceMappings(
      runtime,
      actor(identities.hr),
      tenantId,
      f.first.id,
      { limit: 25 },
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.attendanceProcessingAvailable).toBe(false);
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.hr),
        tenantId,
        f.second.id,
        randomUUID(),
        f.mapping,
      ),
    ).rejects.toThrow('FORBIDDEN');
    const owners = await admin.$queryRaw<{ safe: boolean }[]>`
      SELECT p.prosecdef AND r.rolname='kinto_control_owner' AND p.proconfig=ARRAY['search_path=pg_catalog, public']
      AND NOT has_function_privilege('kinto_worker',p.oid,'EXECUTE') AND NOT has_function_privilege('kinto_dispatcher',p.oid,'EXECUTE') AS safe
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('read_tenant_device_mappings','resolve_tenant_device_mapping','mutate_tenant_device_mapping')`;
    expect(owners).toHaveLength(3);
    expect(owners.every((r) => r.safe)).toBe(true);
  });
  it('resolves exact source strings by device and half-open event-time windows without guessing', async () => {
    const f = await mappingSetup();
    const initial = await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      f.mapping,
    );
    await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.second.id,
      randomUUID(),
      { ...f.mapping, employeeId: f.replacement.id },
    );
    await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      { ...f.mapping, sourceUserId: '7', employeeId: f.replacement.id },
    );
    const resolve = (
      deviceId: string,
      sourceUserId = '0007',
      at = '2026-10-01T00:00:00Z',
    ) =>
      resolveTenantDeviceMapping(
        runtime,
        actor(identities.hr),
        tenantId,
        deviceId,
        { sourceUserId, at },
      );
    expect(await resolve(f.first.id)).toMatchObject({
      status: 'mapped',
      employeeId: f.employee.id,
    });
    expect(await resolve(f.second.id)).toMatchObject({
      status: 'mapped',
      employeeId: f.replacement.id,
    });
    expect(await resolve(f.first.id, '7')).toMatchObject({
      employeeId: f.replacement.id,
    });
    expect(await resolve(f.first.id, 'unknown')).toEqual({
      status: 'unmapped',
      mappingId: null,
      mappingVersion: null,
      employeeId: null,
    });
    expect(
      (await resolve(f.first.id, '0007', '2026-09-30T23:59:59.999Z')).status,
    ).toBe('unmapped');
    await endTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      initial.id,
      randomUUID(),
      {
        expectedVersion: 1,
        effectiveUntil: '2026-10-02T00:00:00Z',
        reason: 'end_mapping',
      },
    );
    await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      {
        ...f.mapping,
        employeeId: f.replacement.id,
        effectiveFrom: '2026-10-02T00:00:00Z',
      },
    );
    expect(
      (await resolve(f.first.id, '0007', '2026-10-01T23:59:59.999Z'))
        .employeeId,
    ).toBe(f.employee.id);
    expect(
      (await resolve(f.first.id, '0007', '2026-10-02T00:00:00Z')).employeeId,
    ).toBe(f.replacement.id);
  });
  it('rejects overlapping windows even on concurrent creation and direct database writes', async () => {
    const f = await mappingSetup();
    const results = await Promise.allSettled(
      [f.employee.id, f.replacement.id].map((employeeId) =>
        createTenantDeviceMapping(
          runtime,
          actor(identities.owner),
          tenantId,
          f.first.id,
          randomUUID(),
          { ...f.mapping, employeeId },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(
      admin.deviceEmployeeMapping.create({
        data: {
          id: randomUUID(),
          tenantId,
          deviceId: f.first.id,
          employeeId: f.replacement.id,
          sourceUserId: '0007',
          effectiveFrom: new Date('2026-10-02T00:00:00Z'),
        },
      }),
    ).rejects.toThrow(/exclusion constraint/);
    expect(
      await admin.deviceEmployeeMapping.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'device.mapping_created' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'device.mapping_changed.v1' },
      }),
    ).toBe(1);
  });
  it('reconciles concurrent mapping retries exactly and rejects changed payloads or lost owner authority', async () => {
    const f = await mappingSetup(),
      key = randomUUID();
    const results = await Promise.all(
      [0, 1].map(() =>
        createTenantDeviceMapping(
          runtime,
          actor(identities.owner),
          tenantId,
          f.first.id,
          key,
          f.mapping,
        ),
      ),
    );
    expect(results[0].id).toBe(results[1].id);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(
      await admin.deviceMappingReceipt.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        key,
        { ...f.mapping, effectiveFrom: '2026-10-01T05:00:00+05:00' },
      ),
    ).toEqual({ ...results[0], replayed: true });
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        key,
        { ...f.mapping, sourceUserId: '8' },
      ),
    ).rejects.toThrow('CONFLICT');
    await admin.membership.update({
      where: {
        tenantId_identityId: { tenantId, identityId: identities.owner },
      },
      data: { status: 'revoked' },
    });
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        key,
        f.mapping,
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('ends mappings with optimistic versions and exact replay without rewriting source identity', async () => {
    const f = await mappingSetup();
    const initial = await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      f.mapping,
    );
    const key = randomUUID(),
      end = {
        expectedVersion: 1,
        effectiveUntil: '2026-10-05T00:00:00Z',
        reason: 'end_mapping' as const,
      };
    const result = await endTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      initial.id,
      key,
      end,
    );
    expect(result).toMatchObject({ version: 2, replayed: false });
    expect(
      await endTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        initial.id,
        key,
        end,
      ),
    ).toEqual({ ...result, replayed: true });
    await expect(
      endTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        initial.id,
        randomUUID(),
        end,
      ),
    ).rejects.toThrow('STALE_VERSION');
    for (const effectiveUntil of [
      '2026-10-01T00:00:00Z',
      '2026-10-05T00:00:00Z',
      '2026-10-06T00:00:00Z',
    ])
      await expect(
        endTenantDeviceMapping(
          runtime,
          actor(identities.owner),
          tenantId,
          f.first.id,
          initial.id,
          randomUUID(),
          { ...end, expectedVersion: 2, effectiveUntil },
        ),
      ).rejects.toThrow('INVALID_STATE');
    await expect(
      endTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.second.id,
        initial.id,
        randomUUID(),
        end,
      ),
    ).rejects.toThrow('NOT_FOUND');
    const saved = await admin.deviceEmployeeMapping.findUniqueOrThrow({
      where: { id: initial.id },
    });
    expect(saved.sourceUserId).toBe('0007');
    expect(saved.employeeId).toBe(f.employee.id);
    expect(saved.effectiveFrom.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'device.mapping_ended' },
      }),
    ).toBe(1);
  });
  it('rejects foreign employees and devices and preserves historical reads after retirement', async () => {
    const f = await mappingSetup();
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        randomUUID(),
        { ...f.mapping, employeeId: f.foreign.id },
      ),
    ).rejects.toThrow('INVALID_STATE');
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        f.first.id,
        randomUUID(),
        { ...f.mapping, employeeId: f.foreign.id },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      admin.deviceEmployeeMapping.create({
        data: {
          id: randomUUID(),
          tenantId,
          deviceId: f.first.id,
          employeeId: f.foreign.id,
          sourceUserId: '0007',
          effectiveFrom: new Date(f.mapping.effectiveFrom),
        },
      }),
    ).rejects.toThrow(/Foreign key constraint/);
    const initial = await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      f.mapping,
    );
    await updateTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      {
        branchId: f.branch.id,
        name: 'Synthetic entrance',
        model: 'ZKTeco_K50',
        firmware: null,
        sourceTimezone: 'Asia/Karachi',
        expectedVersion: 1,
        status: 'retired',
        reason: 'retire_device',
      },
    );
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        randomUUID(),
        { ...f.mapping, sourceUserId: '8' },
      ),
    ).rejects.toThrow('INVALID_STATE');
    await endTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      initial.id,
      randomUUID(),
      {
        expectedVersion: 1,
        effectiveUntil: '2026-10-03T00:00:00Z',
        reason: 'end_mapping',
      },
    );
    expect(
      (
        await readTenantDeviceMappings(
          runtime,
          actor(identities.hr),
          tenantId,
          f.first.id,
          { limit: 25 },
        )
      ).items,
    ).toHaveLength(1);
    await admin.employee.update({
      where: { id: f.replacement.id },
      data: {
        archivedAt: new Date(),
        archivedByIdentityId: identities.owner,
        archiveReason: 'Synthetic archive',
      },
    });
    await expect(
      createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.second.id,
        randomUUID(),
        { ...f.mapping, employeeId: f.replacement.id },
      ),
    ).rejects.toThrow('INVALID_STATE');
    await expect(
      readTenantDeviceMappings(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
        { limit: 25 },
      ),
    ).rejects.toThrow('NOT_FOUND');
  });
  it('paginates mapping history while resolving from the complete history rather than one page', async () => {
    const f = await mappingSetup();
    for (const sourceUserId of ['01', '02', '03'])
      await createTenantDeviceMapping(
        runtime,
        actor(identities.owner),
        tenantId,
        f.first.id,
        randomUUID(),
        { ...f.mapping, sourceUserId },
      );
    const first = await readTenantDeviceMappings(
      runtime,
      actor(identities.hr),
      tenantId,
      f.first.id,
      { limit: 2 },
    );
    expect(first.items).toHaveLength(2);
    const second = await readTenantDeviceMappings(
      runtime,
      actor(identities.hr),
      tenantId,
      f.first.id,
      { limit: 2, afterId: first.nextCursor! },
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((i) => i.id)).size,
    ).toBe(3);
    expect(
      (
        await resolveTenantDeviceMapping(
          runtime,
          actor(identities.hr),
          tenantId,
          f.first.id,
          {
            sourceUserId: second.items[0].sourceUserId,
            at: f.mapping.effectiveFrom,
          },
        )
      ).status,
    ).toBe('mapped');
  });
  it('rolls back mappings, receipts and outbox when audit insertion fails', async () => {
    const f = await mappingSetup();
    const duplicate = await admin.auditEvent.findFirstOrThrow({
      where: { tenantId },
    });
    const request = randomUUID(),
      mapping = randomUUID();
    await expect(
      runtime.$queryRaw`SELECT * FROM public.mutate_tenant_device_mapping(${identities.owner}::uuid,true,${tenantId}::uuid,${f.first.id}::uuid,${request}::uuid,${mapping}::uuid,NULL::integer,${f.employee.id}::uuid,'0007'::varchar,${new Date(f.mapping.effectiveFrom)}::timestamptz,NULL::timestamptz,'initial_mapping'::varchar,${duplicate.id}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow(/23505/);
    expect(
      await admin.deviceEmployeeMapping.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.deviceMappingReceipt.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'device.mapping_changed.v1' },
      }),
    ).toBe(0);
  });
  const fixtureEvent = (sourceEventId = '1') => ({
    connectorEventId: randomUUID(),
    sourceUserId: '0007',
    sourceLocalTimestamp: '2026-10-07T09:00:00',
    sourceEventId,
    direction: 'in' as const,
  });
  const fixtureInbox = async (verified = false) => {
    const br = await setup();
    const device = await createTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      input(br.id),
    );
    const inbox = new SyntheticAttendanceInbox(runtimeUrl!);
    inboxes.push(inbox);
    const scope: AttendanceConnectorScope = {
      tenantId,
      deviceId: device.id,
      connectorId: randomUUID(),
      status: 'active',
      adapterVersion: 'synthetic-1',
      sourceIdentity: verified
        ? { kind: 'vendor_event_id', resetEpoch: randomUUID() }
        : { kind: 'unverified' },
    };
    const batch = (events: unknown[] = [fixtureEvent()]) => ({
      batchId: randomUUID(),
      deviceId: device.id,
      schemaVersion: 1,
      adapterVersion: 'synthetic-1',
      events,
    });
    return { inbox, scope, batch, br, device };
  };

  it('keeps synthetic inbox private behind constrained fixture functions', async () => {
    const f = await fixtureInbox();
    await f.inbox.store(actor(identities.owner), f.batch(), f.scope);
    for (const key of [
      'DATABASE_URL',
      'WORKER_DATABASE_URL',
      'DISPATCHER_DATABASE_URL',
    ]) {
      const db = createDatabase(process.env[key]!);
      try {
        await expect(
          inTenant(db, tenantId, (tx) =>
            tx.syntheticAttendanceEvent.findMany(),
          ),
        ).rejects.toThrow('permission denied');
        await expect(
          db.syntheticAttendanceTransport.findMany(),
        ).rejects.toThrow('permission denied');
        await expect(db.syntheticAttendanceBatch.findMany()).rejects.toThrow(
          'permission denied',
        );
      } finally {
        await db.$disconnect();
      }
    }
    const [grant] = await admin.$queryRaw<{ safe: boolean }[]>`SELECT
      NOT has_function_privilege('kinto_worker','public.store_synthetic_attendance_batch(uuid,boolean,uuid,uuid,uuid,uuid,jsonb,uuid,uuid,uuid)','EXECUTE')
      AND NOT has_function_privilege('kinto_dispatcher','public.store_synthetic_attendance_batch(uuid,boolean,uuid,uuid,uuid,uuid,jsonb,uuid,uuid,uuid)','EXECUTE') AS safe`;
    expect(grant.safe).toBe(true);
  });
  it('persists quarantined events and exact receipts before retry after restart', async () => {
    const f = await fixtureInbox();
    const request = f.batch();
    const receipt = await f.inbox.store(
      actor(identities.owner),
      request,
      f.scope,
    );
    expect(receipt.events[0]).toMatchObject({
      disposition: 'quarantined',
      code: 'source_identity_unverified',
    });
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(1);
    await f.inbox.close();
    const reopened = new SyntheticAttendanceInbox(runtimeUrl!);
    inboxes.push(reopened);
    expect(
      await reopened.store(actor(identities.owner), request, f.scope),
    ).toEqual(receipt);
    expect(
      await admin.syntheticAttendanceBatch.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'attendance.synthetic_inbox_changed.v1' },
      }),
    ).toBe(1);
    await expect(
      reopened.store(
        actor(identities.owner),
        { ...request, events: [fixtureEvent()] },
        f.scope,
      ),
    ).rejects.toThrow('CONFLICT');
  });
  it('deduplicates concurrent batches and source identities across connector replacement', async () => {
    const f = await fixtureInbox(true);
    const e = fixtureEvent();
    const request = f.batch([e]);
    const receipts = await Promise.all(
      Array.from({ length: 6 }, () =>
        f.inbox.store(actor(identities.owner), request, f.scope),
      ),
    );
    expect(receipts.every((r) => r.receiptId === receipts[0].receiptId)).toBe(
      true,
    );
    const overlap = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.inbox.store(actor(identities.owner), f.batch([e]), f.scope),
      ),
    );
    expect(overlap.every((r) => r.events[0].disposition === 'duplicate')).toBe(
      true,
    );
    const replaced = await f.inbox.store(
      actor(identities.owner),
      f.batch([{ ...e, connectorEventId: randomUUID() }]),
      { ...f.scope, connectorId: randomUUID() },
    );
    expect(replaced.events[0].disposition).toBe('duplicate');
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.syntheticAttendanceTransport.count({ where: { tenantId } }),
    ).toBe(2);
  });
  it('retains distinct same-time punches and isolates reset epochs without timestamp deduplication', async () => {
    const f = await fixtureInbox(true);
    const events = [fixtureEvent('1'), fixtureEvent('2')];
    const first = await f.inbox.store(
      actor(identities.owner),
      f.batch(events),
      f.scope,
    );
    expect(first.events.map((e) => e.disposition)).toEqual([
      'quarantined',
      'quarantined',
    ]);
    const repoll = await f.inbox.store(
      actor(identities.owner),
      f.batch(events.map((e) => ({ ...e, connectorEventId: randomUUID() }))),
      f.scope,
    );
    expect(repoll.events.map((e) => e.disposition)).toEqual([
      'duplicate',
      'duplicate',
    ]);
    await f.inbox.store(actor(identities.owner), f.batch([fixtureEvent('1')]), {
      ...f.scope,
      sourceIdentity: { kind: 'vendor_event_id', resetEpoch: randomUUID() },
    });
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(3);
  });
  it('does not collapse unverified source IDs across separate transport identities', async () => {
    const f = await fixtureInbox();
    const e = fixtureEvent();
    await f.inbox.store(
      actor(identities.owner),
      f.batch([e, { ...e, connectorEventId: randomUUID() }]),
      f.scope,
    );
    await f.inbox.store(
      actor(identities.owner),
      f.batch([{ ...e, connectorEventId: randomUUID() }]),
      { ...f.scope, connectorId: randomUUID() },
    );
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(3);
  });
  it('rejects changed transport or source content without overwriting canonical events', async () => {
    const f = await fixtureInbox(true);
    const e = fixtureEvent();
    await f.inbox.store(actor(identities.owner), f.batch([e]), f.scope);
    const transport = await f.inbox.store(
      actor(identities.owner),
      f.batch([{ ...e, sourceUserId: '8' }]),
      f.scope,
    );
    expect(transport.events[0]).toMatchObject({
      disposition: 'rejected_unstored',
      code: 'transport_identity_conflict',
    });
    const source = await f.inbox.store(
      actor(identities.owner),
      f.batch([{ ...e, connectorEventId: randomUUID(), direction: 'out' }]),
      f.scope,
    );
    expect(source.events[0]).toMatchObject({
      disposition: 'rejected_unstored',
      code: 'source_identity_conflict',
    });
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.syntheticAttendanceTransport.count({ where: { tenantId } }),
    ).toBe(1);
  });
  it('stores only sanitized partial-batch dispositions and never rejected biometric payloads', async () => {
    const f = await fixtureInbox();
    const secret = 'SYNTHETIC-FINGERPRINT-NOT-TO-PERSIST';
    const request = f.batch([
      fixtureEvent(),
      { ...fixtureEvent(), fingerprint: secret },
      null,
    ]);
    const receipt = await f.inbox.store(
      actor(identities.owner),
      request,
      f.scope,
    );
    expect(receipt.events.map((e) => e.disposition)).toEqual([
      'quarantined',
      'rejected_unstored',
      'rejected_unstored',
    ]);
    const saved = await admin.syntheticAttendanceBatch.findMany({
      where: { tenantId },
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(saved)).not.toContain(
      createHash('sha256').update(secret).digest('hex'),
    );
    expect(
      await f.inbox.store(
        actor(identities.owner),
        {
          ...request,
          events: [
            request.events[0],
            {
              ...(request.events[1] as object),
              fingerprint: 'ignored-invalid-payload',
            },
            null,
          ],
        },
        f.scope,
      ),
    ).toEqual(receipt);
  });
  it('requires fresh owner permission for every write and replay and isolates foreign devices', async () => {
    const f = await fixtureInbox();
    const request = f.batch();
    await f.inbox.store(actor(identities.owner), request, f.scope);
    for (const who of [
      actor(identities.owner, false),
      actor(identities.hr),
      actor(identities.employee),
      actor(identities.otherOwner),
    ])
      await expect(f.inbox.store(who, request, f.scope)).rejects.toThrow(
        'FORBIDDEN',
      );
    await expect(
      f.inbox.store(actor(identities.otherOwner), request, {
        ...f.scope,
        tenantId: otherTenantId,
      }),
    ).rejects.toThrow('INVALID_STATE');
    await admin.membership.update({
      where: {
        tenantId_identityId: { tenantId, identityId: identities.owner },
      },
      data: { status: 'revoked' },
    });
    await expect(
      f.inbox.store(actor(identities.owner), request, f.scope),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('allows exact reconciliation after retirement but refuses new synthetic records', async () => {
    const f = await fixtureInbox();
    const request = f.batch();
    const receipt = await f.inbox.store(
      actor(identities.owner),
      request,
      f.scope,
    );
    await updateTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      f.device.id,
      {
        ...update(f.br.id),
        name: 'Synthetic entrance',
        firmware: null,
        status: 'retired',
        reason: 'retire_device',
      },
    );
    expect(
      await f.inbox.store(actor(identities.owner), request, f.scope),
    ).toEqual(receipt);
    await expect(
      f.inbox.store(actor(identities.owner), f.batch(), f.scope),
    ).rejects.toThrow('INVALID_STATE');
  });
  it('rolls back raw records and receipts when audit insertion fails', async () => {
    const f = await fixtureInbox();
    const blocked = await admin.auditEvent.findFirstOrThrow({
      where: { tenantId },
    });
    const e = fixtureEvent();
    const packet = [
      {
        index: 0,
        state: 'candidate',
        connectorEventId: e.connectorEventId,
        event: e,
        sourceKey: null,
      },
    ];
    await expect(
      runtime.$queryRaw`SELECT * FROM public.store_synthetic_attendance_batch(${identities.owner}::uuid,true,${tenantId}::uuid,${f.device.id}::uuid,${f.scope.connectorId}::uuid,${randomUUID()}::uuid,${JSON.stringify(packet)}::jsonb,${randomUUID()}::uuid,${blocked.id}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow(/23505/);
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.syntheticAttendanceTransport.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.syntheticAttendanceBatch.count({ where: { tenantId } }),
    ).toBe(0);
  });
  it('rejects injected raw fields at the SQL boundary and durably receipts all-invalid batches', async () => {
    const f = await fixtureInbox();
    const e = fixtureEvent();
    const injected = [
      {
        index: 0,
        state: 'candidate',
        connectorEventId: e.connectorEventId,
        event: { ...e, photo: 'SYNTHETIC-NO-PHOTO' },
        sourceKey: null,
      },
    ];
    const [result] = await runtime.$queryRaw<
      { outcome: string }[]
    >`SELECT * FROM public.store_synthetic_attendance_batch(${identities.owner}::uuid,true,${tenantId}::uuid,${f.device.id}::uuid,${f.scope.connectorId}::uuid,${randomUUID()}::uuid,${JSON.stringify(injected)}::jsonb,${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
    expect(result.outcome).toBe('invalid_state');
    const request = f.batch([
      null,
      { ...e, fingerprint: 'SYNTHETIC-NO-TEMPLATE' },
    ]);
    const receipt = await f.inbox.store(
      actor(identities.owner),
      request,
      f.scope,
    );
    expect(
      receipt.events.every((e) => e.disposition === 'rejected_unstored'),
    ).toBe(true);
    expect(
      await f.inbox.store(actor(identities.owner), request, f.scope),
    ).toEqual(receipt);
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.syntheticAttendanceTransport.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.syntheticAttendanceBatch.count({ where: { tenantId } }),
    ).toBe(1);
  });
  it('rolls back the complete synthetic batch when outbox insertion fails', async () => {
    const f = await fixtureInbox();
    const e = fixtureEvent();
    const existing = await admin.outboxEvent.findFirstOrThrow({
      where: { tenantId },
    });
    const packet = [
      {
        index: 0,
        state: 'candidate',
        connectorEventId: e.connectorEventId,
        event: e,
        sourceKey: null,
      },
    ];
    const audits = await admin.auditEvent.count({ where: { tenantId } });
    await expect(
      runtime.$queryRaw`SELECT * FROM public.store_synthetic_attendance_batch(${identities.owner}::uuid,true,${tenantId}::uuid,${f.device.id}::uuid,${f.scope.connectorId}::uuid,${randomUUID()}::uuid,${JSON.stringify(packet)}::jsonb,${randomUUID()}::uuid,${randomUUID()}::uuid,${existing.id}::uuid)`,
    ).rejects.toThrow(/23505/);
    expect(
      await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.syntheticAttendanceTransport.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.syntheticAttendanceBatch.count({ where: { tenantId } }),
    ).toBe(0);
    expect(await admin.auditEvent.count({ where: { tenantId } })).toBe(audits);
  });
  it('observes synthetic inbox facts once without access to raw attendance', async () => {
    const f = await fixtureInbox();
    await f.inbox.store(actor(identities.owner), f.batch(), f.scope);
    const event = await admin.outboxEvent.findFirstOrThrow({
      where: { tenantId, type: 'attendance.synthetic_inbox_changed.v1' },
    });
    const db = createDatabase(process.env.WORKER_DATABASE_URL!);
    try {
      await processEvent(db, { tenantId, eventId: event.id });
      await processEvent(db, { tenantId, eventId: event.id });
      expect(
        await admin.consumerReceipt.count({
          where: { tenantId, eventId: event.id },
        }),
      ).toBe(1);
      await expect(db.syntheticAttendanceEvent.findMany()).rejects.toThrow(
        'permission denied',
      );
    } finally {
      await db.$disconnect();
    }
  });
  it('reconciles a restarted local queue with the original durable server receipt after a lost ACK', async () => {
    const f = await fixtureInbox();
    const directory = mkdtempSync(join(tmpdir(), 'kinto-inbox-queue-'));
    const options = {
      mode: 'local_test' as const,
      directory,
      binding: {
        tenantId,
        connectorId: f.scope.connectorId,
        deviceId: f.device.id,
        adapterVersion: f.scope.adapterVersion,
      },
    };
    let queue = new SyntheticAttendanceQueue(options);
    try {
      const e = fixtureEvent();
      queue.capture([e]);
      const request = queue.nextBatch()!;
      const lostAck = await f.inbox.store(
        actor(identities.owner),
        request,
        f.scope,
      );
      // Server committed, but process exits before locally applying the reply.
      queue.close();
      queue = new SyntheticAttendanceQueue(options);
      expect(queue.nextBatch()).toEqual(request);
      expect(queue.summary().pending).toBe(1);
      const replay = await f.inbox.store(
        actor(identities.owner),
        queue.nextBatch(),
        f.scope,
      );
      expect(replay).toEqual(lostAck);
      queue.acknowledge(replay);
      expect(queue.capture([e])).toEqual({ inserted: 0 });
      expect(queue.nextBatch()).toBeNull();
      expect(queue.summary()).toMatchObject({
        pending: 0,
        acknowledged: 1,
        held: 0,
      });
      expect(
        await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
      ).toBe(1);
      expect(
        await admin.syntheticAttendanceBatch.count({ where: { tenantId } }),
      ).toBe(1);
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('retains unconfirmed uploads unchanged and acknowledges server-side re-poll duplicates', async () => {
    const f = await fixtureInbox(true);
    const directory = mkdtempSync(join(tmpdir(), 'kinto-inbox-queue-'));
    const queue = new SyntheticAttendanceQueue({
      mode: 'local_test',
      directory,
      binding: {
        tenantId,
        connectorId: f.scope.connectorId,
        deviceId: f.device.id,
        adapterVersion: f.scope.adapterVersion,
      },
    });
    try {
      const e = fixtureEvent();
      queue.capture([e]);
      const request = queue.nextBatch()!;
      await expect(
        f.inbox.store(actor(identities.owner, false), request, f.scope),
      ).rejects.toThrow('FORBIDDEN');
      expect(queue.nextBatch()).toEqual(request);
      expect(queue.summary().pending).toBe(1);
      queue.acknowledge(
        await f.inbox.store(actor(identities.owner), request, f.scope),
      );
      queue.capture([{ ...e, connectorEventId: randomUUID() }]);
      const duplicate = await f.inbox.store(
        actor(identities.owner),
        queue.nextBatch(),
        f.scope,
      );
      expect(duplicate.events[0].disposition).toBe('duplicate');
      queue.acknowledge(duplicate);
      expect(queue.summary().acknowledged).toBe(2);
      expect(
        await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
      ).toBe(1);
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('retains server-rejected source conflicts locally through restart and explicit unchanged retry', async () => {
    const f = await fixtureInbox(true);
    const directory = mkdtempSync(join(tmpdir(), 'kinto-inbox-queue-'));
    const options = {
      mode: 'local_test' as const,
      directory,
      binding: {
        tenantId,
        connectorId: f.scope.connectorId,
        deviceId: f.device.id,
        adapterVersion: f.scope.adapterVersion,
      },
    };
    let queue = new SyntheticAttendanceQueue(options);
    try {
      const e = fixtureEvent();
      queue.capture([e]);
      queue.acknowledge(
        await f.inbox.store(
          actor(identities.owner),
          queue.nextBatch(),
          f.scope,
        ),
      );
      const conflict = {
        ...e,
        connectorEventId: randomUUID(),
        sourceUserId: 'other',
      };
      queue.capture([conflict]);
      const request = queue.nextBatch()!;
      const receipt = await f.inbox.store(
        actor(identities.owner),
        request,
        f.scope,
      );
      expect(receipt.events[0]).toMatchObject({
        disposition: 'rejected_unstored',
        code: 'source_identity_conflict',
      });
      queue.acknowledge(receipt);
      queue.close();
      queue = new SyntheticAttendanceQueue(options);
      expect(queue.summary().held).toBe(1);
      expect(queue.nextBatch()).toBeNull();
      queue.retryHeld([conflict.connectorEventId]);
      const retry = queue.nextBatch()!;
      expect(retry.batchId).not.toBe(request.batchId);
      expect(retry.events).toEqual([conflict]);
      queue.acknowledge(
        await f.inbox.store(actor(identities.owner), retry, f.scope),
      );
      expect(queue.summary()).toMatchObject({
        pending: 0,
        acknowledged: 1,
        held: 1,
      });
      expect(
        await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
      ).toBe(1);
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('retries an uncertain synthetic delivery explicitly and reconciles the original server commit once', async () => {
    const f = await fixtureInbox();
    const directory = mkdtempSync(join(tmpdir(), 'kinto-delivery-inbox-'));
    const queue = new SyntheticAttendanceQueue({
      mode: 'local_test',
      directory,
      binding: {
        tenantId,
        connectorId: f.scope.connectorId,
        deviceId: f.device.id,
        adapterVersion: f.scope.adapterVersion,
      },
    });
    try {
      queue.capture([fixtureEvent()]);
      let calls = 0;
      let committed: unknown;
      const delivery = new SyntheticAttendanceDelivery(
        queue,
        async (batch) => {
          calls++;
          const receipt = await f.inbox.store(
            actor(identities.owner),
            batch,
            f.scope,
          );
          if (calls === 1) {
            committed = receipt;
            throw new Error('Synthetic lost ACK');
          }
          expect(receipt).toEqual(committed);
          return receipt;
        },
        { mode: 'local_test' },
      );
      expect(await delivery.deliver()).toEqual({
        outcome: 'paused',
        attempts: 1,
        reason: 'unconfirmed',
      });
      expect(queue.summary().pending).toBe(1);
      expect(await delivery.deliver()).toEqual({
        outcome: 'delivered',
        attempts: 1,
      });
      expect(calls).toBe(2);
      expect(queue.summary().acknowledged).toBe(1);
      expect(
        await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
      ).toBe(1);
      expect(
        await admin.syntheticAttendanceBatch.count({ where: { tenantId } }),
      ).toBe(1);
      expect(
        await admin.outboxEvent.count({
          where: { tenantId, type: 'attendance.synthetic_inbox_changed.v1' },
        }),
      ).toBe(1);
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('keeps denied deliveries and server-rejected source conflicts durable without automatic retry', async () => {
    const f = await fixtureInbox(true);
    const directory = mkdtempSync(join(tmpdir(), 'kinto-delivery-inbox-'));
    const queue = new SyntheticAttendanceQueue({
      mode: 'local_test',
      directory,
      binding: {
        tenantId,
        connectorId: f.scope.connectorId,
        deviceId: f.device.id,
        adapterVersion: f.scope.adapterVersion,
      },
    });
    try {
      const e = fixtureEvent();
      queue.capture([e]);
      const denied = new SyntheticAttendanceDelivery(
        queue,
        async (batch) => {
          try {
            return await f.inbox.store(
              actor(identities.owner, false),
              batch,
              f.scope,
            );
          } catch {
            throw new SyntheticTransportFailure('denied');
          }
        },
        { mode: 'local_test' },
      );
      expect(await denied.deliver()).toEqual({
        outcome: 'paused',
        attempts: 1,
        reason: 'denied',
      });
      await expect(denied.deliver()).rejects.toThrow('DENIED');
      expect(queue.summary().pending).toBe(1);
      // A new trusted exercise uses fresh server authority; queue identity is unchanged.
      const fresh = new SyntheticAttendanceDelivery(
        queue,
        (batch) => f.inbox.store(actor(identities.owner), batch, f.scope),
        { mode: 'local_test' },
      );
      expect((await fresh.deliver()).outcome).toBe('delivered');
      queue.capture([
        { ...e, connectorEventId: randomUUID(), sourceUserId: 'other' },
      ]);
      expect((await fresh.deliver()).outcome).toBe('delivered');
      expect(queue.summary().held).toBe(1);
      expect(await fresh.deliver()).toEqual({ outcome: 'idle', attempts: 0 });
      expect(
        await admin.syntheticAttendanceEvent.count({ where: { tenantId } }),
      ).toBe(1);
    } finally {
      queue.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reviews quarantined inbox pages for owner and HR without exposing deduplication metadata', async () => {
    const f = await fixtureInbox();
    expect(
      (await f.inbox.review(actor(identities.hr), tenantId, f.device.id)).items,
    ).toEqual([]);
    await f.inbox.store(
      actor(identities.owner),
      f.batch(Array.from({ length: 5 }, (_, i) => fixtureEvent(String(i)))),
      f.scope,
    );
    const all = await f.inbox.review(
      actor(identities.owner),
      tenantId,
      f.device.id,
    );
    const ids: string[] = [];
    let afterId: string | undefined;
    do {
      const page = await f.inbox.review(
        actor(identities.hr),
        tenantId,
        f.device.id,
        { limit: 2, ...(afterId ? { afterId } : {}) },
      );
      expect(page).toMatchObject({
        clockVerified: false,
        sourceIdentityVerified: false,
        attendanceProcessingAvailable: false,
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      ids.push(...page.items.map((e) => e.id));
      afterId = page.nextCursor ?? undefined;
    } while (afterId);
    expect(ids).toEqual(all.items.map((e) => e.id));
    expect(new Set(ids).size).toBe(5);
    expect(JSON.stringify(all)).not.toContain('sourceKey');
    expect(JSON.stringify(all)).not.toContain('connectorId');
    expect(
      all.items.every(
        (e) =>
          e.payload.sourceUserId === '0007' &&
          e.quarantineCode === 'source_identity_unverified',
      ),
    ).toBe(true);
  });
  const inboxMappingFixture = async () => {
    const f = await mappingSetup();
    const inbox = new SyntheticAttendanceInbox(runtimeUrl!);
    inboxes.push(inbox);
    const scope: AttendanceConnectorScope = {
      tenantId,
      deviceId: f.first.id,
      connectorId: randomUUID(),
      status: 'active',
      adapterVersion: 'synthetic-1',
      sourceIdentity: { kind: 'unverified' },
    };
    await inbox.store(
      actor(identities.owner),
      {
        batchId: randomUUID(),
        schemaVersion: 1,
        deviceId: f.first.id,
        adapterVersion: scope.adapterVersion,
        events: [fixtureEvent()],
      },
      scope,
    );
    const raw = (
      await inbox.review(actor(identities.owner), tenantId, f.first.id)
    ).items[0];
    return { ...f, inbox, scope, raw };
  };
  it('previews mappings from persisted exact source identity and explicit half-open what-if time without attendance effects', async () => {
    const f = await inboxMappingFixture();
    const first = await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      { ...f.mapping, effectiveUntil: '2026-10-02T00:00:00Z' },
    );
    const second = await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      {
        ...f.mapping,
        employeeId: f.replacement.id,
        effectiveFrom: '2026-10-02T00:00:00Z',
      },
    );
    const beforeEvents = await admin.syntheticAttendanceEvent.findMany({
      where: { tenantId },
    });
    const audits = await admin.auditEvent.count({ where: { tenantId } }),
      outbox = await admin.outboxEvent.count({ where: { tenantId } });
    for (const [at, expected, employeeId] of [
      ['2026-10-01T23:59:59.999Z', first, f.employee.id],
      ['2026-10-02T05:00:00+05:00', second, f.replacement.id],
    ] as const) {
      const result = await f.inbox.previewMapping(
        actor(identities.hr),
        tenantId,
        f.first.id,
        f.raw.id,
        { at },
      );
      expect(result).toMatchObject({
        timeBasis: 'operator_supplied_unverified',
        clockVerified: false,
        sourceIdentityVerified: false,
        attendanceProcessingAvailable: false,
        resolution: {
          status: 'mapped',
          mappingId: expected.id,
          mappingVersion: 1,
          employeeId,
        },
      });
      expect(result.event.payload.sourceLocalTimestamp).toBe(
        '2026-10-07T09:00:00',
      );
    }
    expect(
      await admin.syntheticAttendanceEvent.findMany({ where: { tenantId } }),
    ).toEqual(beforeEvents);
    expect(await admin.auditEvent.count({ where: { tenantId } })).toBe(audits);
    expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(outbox);
  });
  it('denies stale MFA, employee, foreign and revoked authority on both review and preview', async () => {
    const f = await inboxMappingFixture();
    for (const who of [
      actor(identities.owner, false),
      actor(identities.hr, false),
      actor(identities.employee),
      actor(identities.otherOwner),
    ]) {
      await expect(f.inbox.review(who, tenantId, f.first.id)).rejects.toThrow(
        'FORBIDDEN',
      );
      await expect(
        f.inbox.previewMapping(who, tenantId, f.first.id, f.raw.id, {
          at: '2026-10-07T00:00:00Z',
        }),
      ).rejects.toThrow('FORBIDDEN');
    }
    await admin.membership.update({
      where: { tenantId_identityId: { tenantId, identityId: identities.hr } },
      data: { status: 'revoked' },
    });
    await expect(
      f.inbox.review(actor(identities.hr), tenantId, f.first.id),
    ).rejects.toThrow('FORBIDDEN');
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await expect(
      f.inbox.previewMapping(
        actor(identities.owner),
        tenantId,
        f.first.id,
        f.raw.id,
        { at: '2026-10-07T00:00:00Z' },
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('conceals foreign events and wrong device scopes but preserves review after device retirement', async () => {
    const f = await inboxMappingFixture();
    await expect(
      f.inbox.previewMapping(
        actor(identities.owner),
        tenantId,
        f.second.id,
        f.raw.id,
        { at: '2026-10-07T00:00:00Z' },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      f.inbox.previewMapping(
        actor(identities.otherOwner),
        otherTenantId,
        f.first.id,
        f.raw.id,
        { at: '2026-10-07T00:00:00Z' },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      f.inbox.review(actor(identities.otherOwner), otherTenantId, f.first.id),
    ).rejects.toThrow('NOT_FOUND');
    await updateTenantDeviceInventory(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      {
        ...update(f.branch.id),
        name: 'Synthetic entrance',
        firmware: null,
        status: 'retired',
        reason: 'retire_device',
      },
    );
    expect(
      (await f.inbox.review(actor(identities.hr), tenantId, f.first.id))
        .items[0].id,
    ).toBe(f.raw.id);
    expect(
      (
        await f.inbox.previewMapping(
          actor(identities.hr),
          tenantId,
          f.first.id,
          f.raw.id,
          { at: '2026-10-07T00:00:00Z' },
        )
      ).resolution.status,
    ).toBe('unmapped');
  });
  it('does not guess source strings or accept caller overrides and bounds direct SQL review requests', async () => {
    const f = await inboxMappingFixture();
    await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      { ...f.mapping, sourceUserId: '7' },
    );
    expect(
      (
        await f.inbox.previewMapping(
          actor(identities.owner),
          tenantId,
          f.first.id,
          f.raw.id,
          { at: '2026-10-07T00:00:00Z' },
        )
      ).resolution.status,
    ).toBe('unmapped');
    await expect(
      f.inbox.previewMapping(
        actor(identities.owner),
        tenantId,
        f.first.id,
        f.raw.id,
        { at: '2026-10-07T00:00:00Z', sourceUserId: '7' },
      ),
    ).rejects.toThrow();
    await expect(
      f.inbox.previewMapping(
        actor(identities.owner),
        tenantId,
        f.first.id,
        f.raw.id,
        { at: '2026-10-07T00:00:00' },
      ),
    ).rejects.toThrow();
    for (const limit of [0, 51]) {
      const [row] = await runtime.$queryRaw<
        { outcome: string }[]
      >`SELECT * FROM public.read_synthetic_attendance_events(${identities.owner}::uuid,true,${tenantId}::uuid,${f.first.id}::uuid,${limit}::integer,NULL::uuid)`;
      expect(row.outcome).toBe('invalid_state');
    }
  });
  it('keeps synthetic review functions unavailable to worker and dispatcher and raw tables private', async () => {
    const [row] = await admin.$queryRaw<{ safe: boolean }[]>`SELECT bool_and(
      NOT has_function_privilege('kinto_worker',p.oid,'EXECUTE') AND NOT has_function_privilege('kinto_dispatcher',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AND pg_get_userbyid(p.proowner)='kinto_control_owner') AS safe
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('read_synthetic_attendance_events','preview_synthetic_attendance_mapping')`;
    expect(row.safe).toBe(true);
    await expect(runtime.syntheticAttendanceEvent.findMany()).rejects.toThrow(
      'permission denied',
    );
  });
  it('serves gated synthetic review through real SQL with fresh owner/HR scope and no writes', async () => {
    const f = await inboxMappingFixture();
    await createTenantDeviceMapping(
      runtime,
      actor(identities.owner),
      tenantId,
      f.first.id,
      randomUUID(),
      f.mapping,
    );
    const { redisUrl, namespace } = await machineSetup();
    vi.stubEnv('CONNECTOR_HTTP_MODE', 'local_test');
    vi.stubEnv('CONNECTOR_REDIS_URL', redisUrl);
    vi.stubEnv('CONNECTOR_NAMESPACE', namespace);
    vi.stubEnv('API_HOST', '127.0.0.1');
    vi.stubEnv('NODE_ENV', 'test');
    const service = new MachineService();
    let identityId = identities.owner,
      selectedTenantId = tenantId,
      authTime = Math.floor(Date.now() / 1000);
    const module = await Test.createTestingModule({
      controllers: [LocalConnectorOwnerController],
      providers: [
        { provide: MachineService, useValue: service },
        {
          provide: AuthService,
          useValue: {
            limit: async () => {},
            session: async () => ({
              identityId,
              selectedTenantId,
              authTime,
              principal: { mfaVerified: true },
            }),
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    configureHttp(app);
    const path = `/api/v1/tenants/${tenantId}/local-connectors/devices/${f.first.id}/synthetic-inbox`;
    const get = (url = path) =>
      request(app.getHttpServer())
        .get(url)
        .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43));
    const preview =
      path + '/' + f.raw.id + '/mapping-preview?at=2026-10-01T00:00:00Z';
    const before = await admin.syntheticAttendanceEvent.findMany({
      where: { tenantId },
    });
    const audits = await admin.auditEvent.count({ where: { tenantId } }),
      outbox = await admin.outboxEvent.count({ where: { tenantId } });
    try {
      await app.listen(0, '127.0.0.1');
      for (const user of [identities.owner, identities.hr]) {
        identityId = user;
        const list = await get().expect(200);
        expect(list.headers['cache-control']).toBe('no-store');
        expect(list.body).toMatchObject({
          tenantId,
          deviceId: f.first.id,
          attendanceProcessingAvailable: false,
          items: [{ id: f.raw.id }],
        });
        expect((await get(preview).expect(200)).body).toMatchObject({
          timeBasis: 'operator_supplied_unverified',
          clockVerified: false,
          resolution: { status: 'mapped', employeeId: f.employee.id },
        });
      }
      for (const user of [identities.employee, identities.otherOwner]) {
        identityId = user;
        await get().expect(403);
        await get(preview).expect(403);
      }
      identityId = identities.owner;
      authTime = 1;
      await get().expect(403);
      await get(preview).expect(403);
      authTime = Math.floor(Date.now() / 1000);
      selectedTenantId = otherTenantId;
      await get().expect(403);
      selectedTenantId = tenantId;
      await get(
        path + '/' + randomUUID() + '/mapping-preview?at=2026-10-01T00:00:00Z',
      ).expect(404);
      await admin.membership.updateMany({
        where: { tenantId, identityId },
        data: { status: 'revoked' },
      });
      await get().expect(403);
      await get(preview).expect(403);
      expect(
        await admin.syntheticAttendanceEvent.findMany({ where: { tenantId } }),
      ).toEqual(before);
      expect(await admin.auditEvent.count({ where: { tenantId } })).toBe(
        audits,
      );
      expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(
        outbox,
      );
      await service.onModuleDestroy();
      await get().expect(503);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});
