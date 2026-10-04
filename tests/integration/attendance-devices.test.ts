import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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

  afterEach(async () => {
    const tenants = [tenantId, otherTenantId];
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
});
