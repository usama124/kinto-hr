import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
});
