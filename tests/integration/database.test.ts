import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  activateEmployee,
  assertSafeRuntimeRole,
  createDatabase,
  createEmployeeDraft,
  inTenant,
} from '@kinto/database';
if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (
  !adminUrl ||
  !appUrl ||
  !new URL(adminUrl).pathname.startsWith('/kinto_test') ||
  !new URL(appUrl).pathname.startsWith('/kinto_test')
)
  throw new Error(
    'Integration tests require explicit kinto_test* database URLs; no tests are skipped',
  );
const admin = createDatabase(adminUrl);
const app = createDatabase(
  `${appUrl}${appUrl.includes('?') ? '&' : '?'}connection_limit=2`,
);
const actor = randomUUID();
let tenantA: string;
let tenantB: string;
describe('PostgreSQL tenant and transactional boundary', () => {
  beforeAll(async () => {
    await assertSafeRuntimeRole(app);
  });
  beforeEach(async () => {
    tenantA = randomUUID();
    tenantB = randomUUID();
    await admin.tenant.createMany({
      data: [
        {
          id: tenantA,
          name: 'Synthetic company A',
          employeeLimit: 1,
          billingMode: 'complimentary',
        },
        { id: tenantB, name: 'Synthetic company B', employeeLimit: 5 },
      ],
    });
  });
  afterEach(async () => {
    const where = { tenantId: { in: [tenantA, tenantB] } };
    await admin.outboxEvent.deleteMany({ where });
    await admin.auditEvent.deleteMany({ where });
    await admin.employee.deleteMany({ where });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
  });
  afterAll(async () => {
    await app.$disconnect();
    await admin.$disconnect();
  });
  it('rejects owner/superuser credentials as runtime credentials', async () => {
    await expect(assertSafeRuntimeRole(admin)).rejects.toThrow(
      'Unsafe runtime database role',
    );
  });
  it('requires RLS and FORCE RLS for every business table', async () => {
    const rows = await admin.$queryRaw<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='public' AND relkind='r' AND relname <> '_prisma_migrations'`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows)
      expect({
        table: row.relname,
        enabled: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      }).toEqual({ table: row.relname, enabled: true, forced: true });
  });
  it('fails closed without tenant context', async () => {
    await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'Synthetic A' },
      actor,
    );
    expect(await app.employee.findMany()).toEqual([]);
    await expect(
      app.employee.create({
        data: { tenantId: tenantA, employeeNumber: '002', name: 'No context' },
      }),
    ).rejects.toThrow();
  });
  it('isolates identical employee numbers and rejects cross-tenant writes', async () => {
    await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'Synthetic A' },
      actor,
    );
    const other = await createEmployeeDraft(
      app,
      tenantB,
      { employeeNumber: '001', name: 'Synthetic B' },
      actor,
    );
    const rows = await inTenant(app, tenantA, (tx) => tx.employee.findMany());
    expect(rows.map((row) => row.name)).toEqual(['Synthetic A']);
    await expect(
      inTenant(app, tenantA, (tx) =>
        tx.employee.create({
          data: { tenantId: tenantB, employeeNumber: '002', name: 'Forged' },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await inTenant(app, tenantA, (tx) =>
        tx.employee.updateMany({
          where: { id: other.id },
          data: { name: 'Forged' },
        }),
      ),
    ).toEqual({ count: 0 });
    await expect(
      activateEmployee(app, tenantA, other.id, 1, actor),
    ).rejects.toThrow('NOT_FOUND');
  });
  it('does not leak transaction context through a reused pool, including rollback', async () => {
    await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'Synthetic A' },
      actor,
    );
    await createEmployeeDraft(
      app,
      tenantB,
      { employeeNumber: '001', name: 'Synthetic B' },
      actor,
    );
    await expect(
      inTenant(app, tenantA, async () => {
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const tenant = i % 2 ? tenantA : tenantB;
        const rows = await inTenant(app, tenant, (tx) =>
          tx.employee.findMany(),
        );
        expect(rows.every((row) => row.tenantId === tenant)).toBe(true);
        expect(rows).toHaveLength(1);
      }),
    );
    expect(await app.employee.findMany()).toEqual([]);
  });
  it('atomically allocates the last seat and records one activation event', async () => {
    const one = await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'One' },
      actor,
    );
    const two = await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '002', name: 'Two' },
      actor,
    );
    const results = await Promise.allSettled([
      activateEmployee(app, tenantA, one.id, 1, actor),
      activateEmployee(app, tenantA, two.id, 1, actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason.code).toBe(
      'CAPACITY_REACHED',
    );
    expect(
      await admin.employee.count({
        where: { tenantId: tenantA, status: 'active' },
      }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId: tenantA, action: 'employee.activated' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({ where: { tenantId: tenantA } }),
    ).toBe(1);
  });
  it('rolls back employee and audit changes when durable event persistence fails', async () => {
    const employee = await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'One' },
      actor,
    );
    await admin.outboxEvent.create({
      data: {
        tenantId: tenantA,
        aggregateId: employee.id,
        aggregateVersion: 2,
        type: 'employee.activated.v1',
      },
    });
    await expect(
      activateEmployee(app, tenantA, employee.id, 1, actor),
    ).rejects.toThrow();
    expect(
      (await admin.employee.findUniqueOrThrow({ where: { id: employee.id } }))
        .status,
    ).toBe('draft');
    expect(
      await admin.auditEvent.count({
        where: { tenantId: tenantA, action: 'employee.activated' },
      }),
    ).toBe(0);
  });
  it('rejects stale/repeated activation without duplicate events', async () => {
    const employee = await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'One' },
      actor,
    );
    await activateEmployee(app, tenantA, employee.id, 1, actor);
    await expect(
      activateEmployee(app, tenantA, employee.id, 1, actor),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      activateEmployee(app, tenantA, employee.id, 2, actor),
    ).rejects.toThrow('INVALID_STATE');
    expect(
      await admin.outboxEvent.count({ where: { tenantId: tenantA } }),
    ).toBe(1);
  });
  it('denies suspended tenants and preserves their data', async () => {
    const employee = await createEmployeeDraft(
      app,
      tenantA,
      { employeeNumber: '001', name: 'One' },
      actor,
    );
    await admin.tenant.update({
      where: { id: tenantA },
      data: { status: 'suspended' },
    });
    await expect(
      activateEmployee(app, tenantA, employee.id, 1, actor),
    ).rejects.toThrow('TENANT_UNAVAILABLE');
    expect(await admin.employee.count({ where: { tenantId: tenantA } })).toBe(
      1,
    );
    await expect(
      inTenant(app, randomUUID(), (tx) => tx.employee.findMany()),
    ).rejects.toThrow('TENANT_UNAVAILABLE');
  });
  it('denies runtime mutation of plans and deletion of audit history', async () => {
    await expect(
      inTenant(app, tenantA, (tx) =>
        tx.tenant.update({
          where: { id: tenantA },
          data: { employeeLimit: 250 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inTenant(app, tenantA, (tx) => tx.auditEvent.deleteMany()),
    ).rejects.toThrow();
  });
});
