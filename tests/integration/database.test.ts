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
import {
  schemaIsolationInventory,
  verifySchemaIsolation,
  validateIsolationInventory,
} from '../../scripts/schema-isolation';
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
  it('classifies every business table with exact policies, grants and regression evidence', async () => {
    expect(await verifySchemaIsolation(admin)).toBe(
      schemaIsolationInventory.length,
    );
  });
  it('rejects missing test evidence, duplicate entries and missing scope columns', async () => {
    const employee = schemaIsolationInventory.find(
      ({ name }) => name === 'employees',
    )!;
    await expect(
      validateIsolationInventory([employee, employee]),
    ).rejects.toThrow('Duplicate table classification');
    await expect(
      validateIsolationInventory([{ ...employee, tenantColumn: null }]),
    ).rejects.toThrow('Missing tenant classification: employees');
    await expect(
      validateIsolationInventory([
        {
          ...employee,
          regression: {
            ...employee.regression,
            scenario: 'synthetic nonexistent regression',
          },
        },
      ]),
    ).rejects.toThrow('Missing regression scenario: employees');
  });
  it.each([
    [
      'unclassified table',
      'CREATE TABLE public.synthetic_unclassified (id uuid)',
      'Unclassified or missing business table',
    ],
    [
      'renamed table with unchanged table count',
      'ALTER TABLE public.employee_account_requests RENAME TO synthetic_missing_classification',
      'Unclassified or missing business table',
    ],
    [
      'disabled RLS',
      'ALTER TABLE public.employees DISABLE ROW LEVEL SECURITY',
      'RLS boundary mismatch: employees',
    ],
    [
      'missing FORCE RLS',
      'ALTER TABLE public.employees NO FORCE ROW LEVEL SECURITY',
      'RLS boundary mismatch: employees',
    ],
    [
      'permissive tenant read',
      'ALTER POLICY tenant_scope ON public.employees USING (true)',
      'Policy boundary mismatch: employees',
    ],
    [
      'permissive tenant write',
      'ALTER POLICY tenant_scope ON public.employees WITH CHECK (true)',
      'Policy boundary mismatch: employees',
    ],
    [
      'additional public policy',
      'CREATE POLICY synthetic_public_access ON public.employee_account_requests USING (true)',
      'Policy boundary mismatch: employee_account_requests',
    ],
    [
      'broadened control owner role',
      'ALTER POLICY platform_control ON public.employee_account_requests TO PUBLIC',
      'Policy boundary mismatch: employee_account_requests',
    ],
    [
      'public table grant',
      'GRANT SELECT ON public.employee_private_details TO PUBLIC',
      'Table privilege mismatch: employee_private_details',
    ],
    [
      'column-only grant',
      'GRANT SELECT (email) ON public.employee_account_requests TO kinto_app',
      'Column privilege mismatch: employee_account_requests',
    ],
    [
      'broadened worker column grant',
      'GRANT UPDATE (tenant_id) ON public.job_deliveries TO kinto_worker',
      'Column privilege mismatch: job_deliveries',
    ],
    [
      'unsafe runtime role',
      'ALTER ROLE kinto_app BYPASSRLS',
      'Unsafe isolation role: kinto_app',
    ],
    [
      'login-enabled function owner',
      'ALTER ROLE kinto_control_owner LOGIN',
      'Unsafe isolation role: kinto_control_owner',
    ],
    [
      'missing tenant policy',
      'DROP POLICY tenant_scope ON public.employees',
      'Policy boundary mismatch: employees',
    ],
    [
      'nullable tenant column',
      'ALTER TABLE public.employees ALTER COLUMN tenant_id DROP NOT NULL',
      'Nullable tenant column: employees',
    ],
  ])(
    'rejects %s and rolls back synthetic catalog changes',
    async (_label, sql, message) => {
      const rollback = new Error('synthetic catalog rollback');
      await expect(
        admin.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(sql);
            await expect(verifySchemaIsolation(tx)).rejects.toThrow(message);
            throw rollback;
          },
          { timeout: 15000 },
        ),
      ).rejects.toBe(rollback);
      await verifySchemaIsolation(admin);
    },
  );
  it('denies unscoped runtime reads across the entire classified inventory', async () => {
    for (const table of schemaIsolationInventory) {
      // Names come only from the reviewed inventory, never an API or operator input.
      expect(table.name).toMatch(/^[a-z_]+$/);
      const query = app.$queryRawUnsafe(
        `SELECT 1 FROM public."${table.name}" LIMIT 1`,
      );
      if (table.grants.kinto_app?.includes('SELECT'))
        expect(await query).toEqual([]);
      else await expect(query).rejects.toThrow(/permission denied/);
    }
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
