import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateTenantEmployee,
  createDatabase,
  createTenantBranch,
  createTenantEmployee,
  createTenantLegalEntity,
  createTenantOrganizationCatalogEntry,
  readTenantEmployee,
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
  throw new Error(
    'Employee activation tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const starterPlanId = '10000000-0000-4000-8000-000000000020';
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let hrId: string;
let employeeIdentityId: string;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});

async function setupOrganization() {
  await createTenantLegalEntity(runtime, actor(ownerId), tenantId, {
    legalName: 'Activation Fixture Private Limited',
    provinceCode: 'PK-PB',
    reason: 'Create activation fixture employer',
  });
  const branch = await createTenantBranch(runtime, actor(ownerId), tenantId, {
    code: 'LHR-ACT',
    name: 'Lahore',
    provinceCode: 'PK-PB',
    reason: 'Create activation branch',
  });
  const department = await createTenantOrganizationCatalogEntry(
    runtime,
    actor(ownerId),
    tenantId,
    'department',
    {
      code: 'ENG-ACT',
      name: 'Engineering',
      reason: 'Create activation department',
    },
  );
  const designation = await createTenantOrganizationCatalogEntry(
    runtime,
    actor(ownerId),
    tenantId,
    'designation',
    {
      code: 'SWE-ACT',
      name: 'Software Engineer',
      reason: 'Create activation designation',
    },
  );
  return {
    branchId: branch.id,
    departmentId: department.id,
    designationId: designation.id,
  };
}

async function createDraft(
  number: string,
  refs: Awaited<ReturnType<typeof setupOrganization>>,
) {
  return createTenantEmployee(runtime, actor(hrId), tenantId, {
    employeeNumber: number,
    name: `Employee ${number}`,
    joiningDate: new Date().toISOString().slice(0, 10),
    employmentType: 'monthly_salaried',
    ...refs,
    managerEmployeeId: null,
    topLevelReason: 'Approved top-level fixture role',
    reason: 'Create activation-ready employee',
  });
}

describe('capacity-backed complete employee activation', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    hrId = randomUUID();
    employeeIdentityId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Activation tenant',
        employeeLimit: 1,
      })),
    });
    await admin.tenantSubscription.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id: randomUUID(),
        tenantId: id,
        subscriptionVersion: 1,
        planVersionId: starterPlanId,
        billingMode: 'complimentary',
        employeeLimit: 1,
        reason: 'Synthetic activation entitlement',
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, hrId, employeeIdentityId].map((id, index) => ({
        id,
        issuer: 'https://activation.synthetic.example/realm',
        subject: `identity-${index}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        { tenantId, identityId: hrId, roles: ['hr_admin'] },
        { tenantId, identityId: employeeIdentityId, roles: ['employee'] },
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
    await admin.employeeAssignment.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employmentPeriod.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employee.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.department.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.designation.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.branch.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.legalEntity.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.membership.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.tenant.deleteMany({ where: { id: { in: tenants } } });
    await admin.identity.deleteMany({
      where: { id: { in: [ownerId, hrId, employeeIdentityId] } },
    });
  });
  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('activates a complete draft and its employment period atomically', async () => {
    const draft = await createDraft('EMP-001', await setupOrganization());
    await expect(
      activateTenantEmployee(runtime, actor(hrId), tenantId, draft.id, {
        expectedVersion: 1,
        reason: 'HR approved employee start',
      }),
    ).resolves.toEqual({ id: draft.id, version: 2, status: 'active' });
    await expect(
      readTenantEmployee(runtime, actor(ownerId), tenantId, draft.id),
    ).resolves.toMatchObject({
      status: 'active',
      version: 2,
    });
    await expect(
      admin.employmentPeriod.findFirstOrThrow({
        where: { tenantId, employeeId: draft.id },
      }),
    ).resolves.toMatchObject({ status: 'active' });
    await expect(
      admin.auditEvent.findFirstOrThrow({
        where: { tenantId, resourceId: draft.id, action: 'employee.activated' },
      }),
    ).resolves.toMatchObject({ reason: 'HR approved employee start' });
    await expect(
      admin.outboxEvent.findFirstOrThrow({
        where: {
          tenantId,
          aggregateId: draft.id,
          type: 'employee.activated.v1',
        },
      }),
    ).resolves.toMatchObject({ aggregateVersion: 2 });
  });

  it('serializes the final seat and creates only one activation event', async () => {
    const refs = await setupOrganization();
    const [one, two] = await Promise.all([
      createDraft('EMP-001', refs),
      createDraft('EMP-002', refs),
    ]);
    const results = await Promise.allSettled(
      [one, two].map((draft) =>
        activateTenantEmployee(runtime, actor(ownerId), tenantId, draft.id, {
          expectedVersion: 1,
          reason: 'Approve final available seat',
        }),
      ),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejection = results.find(({ status }) => status === 'rejected');
    expect(rejection?.status === 'rejected' && rejection.reason.code).toBe(
      'CAPACITY_REACHED',
    );
    expect(
      await admin.employee.count({ where: { tenantId, status: 'active' } }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'employee.activated' },
      }),
    ).toBe(1);
  });

  it('rejects stale, repeated, incomplete and inactive-reference activation', async () => {
    const refs = await setupOrganization();
    const draft = await createDraft('EMP-001', refs);
    await expect(
      activateTenantEmployee(runtime, actor(ownerId), tenantId, draft.id, {
        expectedVersion: 2,
        reason: 'Stale activation request',
      }),
    ).rejects.toThrow('STALE_VERSION');
    await admin.designation.update({
      where: { id: refs.designationId },
      data: { status: 'inactive' },
    });
    await expect(
      activateTenantEmployee(runtime, actor(ownerId), tenantId, draft.id, {
        expectedVersion: 1,
        reason: 'Invalid organization activation',
      }),
    ).rejects.toThrow('INVALID_STATE');
    await admin.designation.update({
      where: { id: refs.designationId },
      data: { status: 'active' },
    });
    await activateTenantEmployee(runtime, actor(ownerId), tenantId, draft.id, {
      expectedVersion: 1,
      reason: 'Valid employee activation',
    });
    await expect(
      activateTenantEmployee(runtime, actor(ownerId), tenantId, draft.id, {
        expectedVersion: 2,
        reason: 'Repeated employee activation',
      }),
    ).rejects.toThrow('INVALID_STATE');
    const legacy = await admin.employee.create({
      data: {
        tenantId,
        employeeNumber: 'LEGACY-001',
        name: 'Incomplete legacy draft',
      },
    });
    await expect(
      activateTenantEmployee(runtime, actor(ownerId), tenantId, legacy.id, {
        expectedVersion: 1,
        reason: 'Incomplete employee activation',
      }),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('enforces role, MFA and tenant boundaries and denies direct table mutation', async () => {
    const draft = await createDraft('EMP-001', await setupOrganization());
    for (const [principal, selectedTenant] of [
      [actor(employeeIdentityId), tenantId],
      [actor(ownerId, false), tenantId],
      [actor(ownerId), otherTenantId],
    ] as const) {
      await expect(
        activateTenantEmployee(runtime, principal, selectedTenant, draft.id, {
          expectedVersion: 1,
          reason: 'Unauthorized activation attempt',
        }),
      ).rejects.toThrow('FORBIDDEN');
    }
    await expect(
      runtime.employee.update({
        where: { id: draft.id },
        data: { status: 'active' },
      }),
    ).rejects.toThrow();
  });
});
