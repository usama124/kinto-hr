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
  scheduleTenantEmployeeTermination,
} from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const dispatcherUrl = process.env.DISPATCHER_DATABASE_URL;
if (
  !adminUrl ||
  !runtimeUrl ||
  !dispatcherUrl ||
  [adminUrl, runtimeUrl, dispatcherUrl].some(
    (url) => !new URL(url).pathname.startsWith('/kinto_test'),
  )
)
  throw new Error(
    'Employee termination tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const dispatcher = createDatabase(dispatcherUrl);
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
const date = (offset: number) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

async function setupOrganization() {
  await createTenantLegalEntity(runtime, actor(ownerId), tenantId, {
    legalName: 'Termination Fixture Private Limited',
    provinceCode: 'PK-PB',
    reason: 'Create termination fixture employer',
  });
  const branch = await createTenantBranch(runtime, actor(ownerId), tenantId, {
    code: 'LHR-TERM',
    name: 'Lahore',
    provinceCode: 'PK-PB',
    reason: 'Create termination branch',
  });
  const department = await createTenantOrganizationCatalogEntry(
    runtime,
    actor(ownerId),
    tenantId,
    'department',
    { code: 'ENG-TERM', name: 'Engineering', reason: 'Create department' },
  );
  const designation = await createTenantOrganizationCatalogEntry(
    runtime,
    actor(ownerId),
    tenantId,
    'designation',
    {
      code: 'SWE-TERM',
      name: 'Software Engineer',
      reason: 'Create designation',
    },
  );
  return {
    branchId: branch.id,
    departmentId: department.id,
    designationId: designation.id,
  };
}

async function createActive(
  number: string,
  refs: Awaited<ReturnType<typeof setupOrganization>>,
  joiningDate = date(0),
  managerEmployeeId: string | null = null,
) {
  const draft = await createTenantEmployee(runtime, actor(hrId), tenantId, {
    employeeNumber: number,
    name: `Employee ${number}`,
    joiningDate,
    employmentType: 'monthly_salaried',
    ...refs,
    managerEmployeeId,
    ...(managerEmployeeId
      ? {}
      : { topLevelReason: 'Approved top-level fixture role' }),
    reason: 'Create termination-ready employee',
  });
  await activateTenantEmployee(runtime, actor(hrId), tenantId, draft.id, {
    expectedVersion: 1,
    reason: 'Activate termination fixture employee',
  });
  return { ...draft, version: 2 };
}

describe('scheduled employee termination and access revocation', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    hrId = randomUUID();
    employeeIdentityId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Termination tenant',
        employeeLimit: 10,
      })),
    });
    await admin.tenantSubscription.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id: randomUUID(),
        tenantId: id,
        subscriptionVersion: 1,
        planVersionId: starterPlanId,
        billingMode: 'complimentary',
        employeeLimit: 10,
        reason: 'Synthetic termination entitlement',
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, hrId, employeeIdentityId].map((id, index) => ({
        id,
        issuer: 'https://termination.synthetic.example/realm',
        subject: `identity-${index}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        { tenantId, identityId: hrId, roles: ['hr_admin'] },
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
    await admin.employeeIdentityLink.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeInvitation.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeAccountRequest.deleteMany({
      where: { tenantId: { in: tenants } },
    });
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
    Promise.all([
      admin.$disconnect(),
      runtime.$disconnect(),
      dispatcher.$disconnect(),
    ]),
  );

  it('records a future final working date while preserving active status and history', async () => {
    const employee = await createActive('EMP-001', await setupOrganization());
    const finalWorkingDate = date(10);
    await expect(
      scheduleTenantEmployeeTermination(
        runtime,
        actor(hrId),
        tenantId,
        employee.id,
        {
          expectedVersion: 2,
          finalWorkingDate,
          reason: 'Approved employee separation',
        },
      ),
    ).resolves.toEqual({ id: employee.id, version: 3, status: 'active' });
    await expect(
      readTenantEmployee(runtime, actor(ownerId), tenantId, employee.id),
    ).resolves.toMatchObject({
      status: 'active',
      version: 3,
      finalWorkingDate,
      assignmentHistory: [{ effectiveTo: finalWorkingDate }],
    });
    await expect(
      admin.employmentPeriod.findFirstOrThrow({
        where: { tenantId, employeeId: employee.id },
      }),
    ).resolves.toMatchObject({
      status: 'active',
      finalWorkingDate: new Date(`${finalWorkingDate}T00:00:00.000Z`),
      terminationScheduledByIdentityId: hrId,
      terminationReason: 'Approved employee separation',
    });
    await expect(
      admin.auditEvent.findFirstOrThrow({
        where: {
          tenantId,
          resourceId: employee.id,
          action: 'employee.termination_scheduled',
        },
      }),
    ).resolves.toMatchObject({ reason: 'Approved employee separation' });
  });

  it('rejects stale, repeated, unauthorized and manager-with-active-report schedules', async () => {
    const refs = await setupOrganization();
    const manager = await createActive('MGR-001', refs);
    await createActive('EMP-002', refs, date(0), manager.id);
    const input = {
      expectedVersion: 2,
      finalWorkingDate: date(10),
      reason: 'Approved manager separation',
    };
    await expect(
      scheduleTenantEmployeeTermination(
        runtime,
        actor(ownerId),
        tenantId,
        manager.id,
        {
          ...input,
          expectedVersion: 3,
        },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      scheduleTenantEmployeeTermination(
        runtime,
        actor(ownerId),
        tenantId,
        manager.id,
        input,
      ),
    ).rejects.toThrow('INVALID_STATE');
    await expect(
      scheduleTenantEmployeeTermination(
        runtime,
        actor(ownerId, false),
        tenantId,
        manager.id,
        input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      scheduleTenantEmployeeTermination(
        runtime,
        actor(ownerId),
        otherTenantId,
        manager.id,
        input,
      ),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('applies a due schedule once, frees its seat and revokes only linked tenant access', async () => {
    const employee = await createActive(
      'EMP-001',
      await setupOrganization(),
      date(-20),
    );
    const finalWorkingDate = date(10);
    await scheduleTenantEmployeeTermination(
      runtime,
      actor(ownerId),
      tenantId,
      employee.id,
      {
        expectedVersion: 2,
        finalWorkingDate,
        reason: 'Approved final working date',
      },
    );
    const requestId = randomUUID();
    const invitationId = randomUUID();
    const membershipId = randomUUID();
    await admin.membership.createMany({
      data: [
        {
          id: membershipId,
          tenantId,
          identityId: employeeIdentityId,
          roles: ['employee'],
        },
        {
          tenantId: otherTenantId,
          identityId: employeeIdentityId,
          roles: ['employee'],
        },
      ],
    });
    await admin.employeeAccountRequest.create({
      data: {
        id: requestId,
        requestKey: randomUUID(),
        tenantId,
        employeeId: employee.id,
        requestedByIdentityId: ownerId,
        email: 'employee@example.com',
        status: 'active',
      },
    });
    await admin.employeeInvitation.create({
      data: {
        id: invitationId,
        requestId,
        tenantId,
        employeeId: employee.id,
        identityId: employeeIdentityId,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(Date.now() - 1_000),
        acceptedAt: new Date(),
      },
    });
    await admin.employeeIdentityLink.create({
      data: {
        id: randomUUID(),
        tenantId,
        employeeId: employee.id,
        identityId: employeeIdentityId,
        membershipId,
        invitationId,
      },
    });
    await admin.employmentPeriod.updateMany({
      where: { tenantId, employeeId: employee.id, status: 'active' },
      data: { finalWorkingDate: new Date(`${date(-1)}T00:00:00.000Z`) },
    });

    const apply = () =>
      dispatcher.$queryRaw<
        { processed: number }[]
      >`SELECT * FROM public.apply_due_employee_terminations(10)`;
    await expect(apply()).resolves.toEqual([{ processed: 1 }]);
    await expect(apply()).resolves.toEqual([{ processed: 0 }]);
    await expect(
      admin.employee.findUniqueOrThrow({ where: { id: employee.id } }),
    ).resolves.toMatchObject({ status: 'terminated', version: 4 });
    await expect(
      admin.employmentPeriod.findFirstOrThrow({
        where: { tenantId, employeeId: employee.id },
      }),
    ).resolves.toMatchObject({ status: 'ended' });
    await expect(
      admin.membership.findUniqueOrThrow({ where: { id: membershipId } }),
    ).resolves.toMatchObject({ status: 'revoked', version: 2 });
    expect(
      await admin.membership.count({
        where: {
          tenantId: otherTenantId,
          identityId: employeeIdentityId,
          status: 'active',
        },
      }),
    ).toBe(1);
    await expect(
      admin.identity.findUniqueOrThrow({ where: { id: employeeIdentityId } }),
    ).resolves.toMatchObject({ status: 'active' });
    expect(
      await admin.employee.count({ where: { tenantId, status: 'active' } }),
    ).toBe(0);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'employee.terminated' },
      }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'employee.access_revoked' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'employee.terminated.v1' },
      }),
    ).toBe(1);
  });

  it('denies direct lifecycle mutation to the application role', async () => {
    const employee = await createActive('EMP-001', await setupOrganization());
    await expect(
      runtime.employee.update({
        where: { id: employee.id },
        data: { status: 'terminated' },
      }),
    ).rejects.toThrow();
    await expect(
      runtime.$queryRaw`SELECT * FROM public.apply_due_employee_terminations(1)`,
    ).rejects.toThrow();
    await expect(dispatcher.employee.findMany({ take: 1 })).rejects.toThrow();
  });
});
