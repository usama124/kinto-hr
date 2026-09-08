import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createTenantBranch,
  createTenantEmployee,
  createTenantEmployeeAssignment,
  createTenantLegalEntity,
  createTenantOrganizationCatalogEntry,
  readTenantEmployee,
  readTenantEmployees,
  updateTenantEmployeeProfile,
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
    'Employee record tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let identities: Record<'owner' | 'hr' | 'employee' | 'otherOwner', string>;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const date = (offset: number) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
type OrganizationRefs = {
  branchId: string;
  departmentId: string;
  designationId: string;
};
async function setupOrganization(
  selectedTenant: string,
  ownerId: string,
  suffix: string,
): Promise<OrganizationRefs> {
  const principal = actor(ownerId);
  await createTenantLegalEntity(runtime, principal, selectedTenant, {
    legalName: `Employee fixture ${suffix} Private Limited`,
    provinceCode: 'PK-PB',
    reason: 'Create employee fixture employer',
  });
  const branch = await createTenantBranch(runtime, principal, selectedTenant, {
    code: `LHR-${suffix}`,
    name: `Lahore ${suffix}`,
    provinceCode: 'PK-PB',
    reason: 'Create employee fixture branch',
  });
  const department = await createTenantOrganizationCatalogEntry(
    runtime,
    principal,
    selectedTenant,
    'department',
    {
      code: `ENG-${suffix}`,
      name: 'Engineering',
      reason: 'Create employee fixture department',
    },
  );
  const designation = await createTenantOrganizationCatalogEntry(
    runtime,
    principal,
    selectedTenant,
    'designation',
    {
      code: `SWE-${suffix}`,
      name: 'Software Engineer',
      reason: 'Create employee fixture designation',
    },
  );
  return {
    branchId: branch.id,
    departmentId: department.id,
    designationId: designation.id,
  };
}

describe('tenant employee records and effective assignments', () => {
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
        name: 'Synthetic people tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: Object.entries(identities).map(([name, id]) => ({
        id,
        issuer: 'https://people.synthetic.example/realm',
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
    await admin.employeeAssignment.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employmentPeriod.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeIdentityLink.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeInvitation.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeAccountRequest.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employee.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.companyPolicyVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
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
      where: { id: { in: Object.values(identities) } },
    });
  });
  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('creates complete tenant-scoped drafts and exposes no private or salary fields', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'A');
    const otherRefs = await setupOrganization(
      otherTenantId,
      identities.otherOwner,
      'B',
    );
    const input = {
      employeeNumber: ' emp-001 ',
      name: ' Sana Khan ',
      legalName: 'Sana Khan',
      joiningDate: date(-1),
      employmentType: 'monthly_salaried' as const,
      ...refs,
      managerEmployeeId: null,
      topLevelReason: 'Company chief executive',
      reason: 'Create complete employee draft',
    };
    const created = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      input,
    );
    expect(created.version).toBe(1);
    const record = await readTenantEmployee(
      runtime,
      actor(identities.owner),
      tenantId,
      created.id,
    );
    expect(record).toMatchObject({
      employeeNumber: 'EMP-001',
      name: 'Sana Khan',
      status: 'draft',
      joiningDate: date(-1),
      employmentType: 'monthly_salaried',
      payrollSetup: 'incomplete',
      currentAssignment: {
        branch: { id: refs.branchId },
        department: { id: refs.departmentId },
        designation: { id: refs.designationId },
        manager: null,
        topLevelReason: 'Company chief executive',
      },
    });
    expect(JSON.stringify(record)).not.toMatch(/salary|bank|cnic/i);
    await expect(
      runtime.$queryRaw`SELECT public.employee_record_json(${tenantId}::uuid, ${created.id}::uuid)`,
    ).rejects.toThrow();
    await expect(
      runtime.$queryRaw`SELECT public.tenant_people_authorized(${identities.hr}::uuid, true, ${tenantId}::uuid, false)`,
    ).rejects.toThrow();
    await expect(
      createTenantEmployee(runtime, actor(identities.hr), tenantId, input),
    ).rejects.toThrow('CONFLICT');
    await expect(
      createTenantEmployee(runtime, actor(identities.employee), tenantId, {
        ...input,
        employeeNumber: 'EMP-002',
      }),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readTenantEmployees(runtime, actor(identities.hr, false), tenantId),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readTenantEmployee(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        created.id,
      ),
    ).rejects.toThrow('NOT_FOUND');
    const sameNumber = await createTenantEmployee(
      runtime,
      actor(identities.otherOwner),
      otherTenantId,
      {
        ...input,
        ...otherRefs,
      },
    );
    expect(sameNumber.id).not.toBe(created.id);
  });

  it('versions profiles and rejects stale, no-op and inactive organization references', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'A');
    const created = await createTenantEmployee(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        employeeNumber: 'EMP-010',
        name: 'Original Name',
        joiningDate: date(-2),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Company leader',
        reason: 'Create profile fixture',
      },
    );
    expect(
      await updateTenantEmployeeProfile(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
        {
          expectedVersion: 1,
          name: 'Updated Name',
          legalName: 'Updated Legal Name',
          reason: 'Correct approved employee names',
        },
      ),
    ).toEqual({ id: created.id, version: 2 });
    await expect(
      updateTenantEmployeeProfile(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
        {
          expectedVersion: 1,
          name: 'Stale Name',
          reason: 'Attempt stale employee update',
        },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      updateTenantEmployeeProfile(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
        {
          expectedVersion: 2,
          name: 'Updated Name',
          legalName: 'Updated Legal Name',
          reason: 'Attempt a no-op employee update',
        },
      ),
    ).rejects.toThrow('INVALID_STATE');
    await admin.department.update({
      where: { id: refs.departmentId },
      data: { status: 'inactive' },
    });
    await expect(
      createTenantEmployee(runtime, actor(identities.hr), tenantId, {
        employeeNumber: 'EMP-011',
        name: 'Invalid Department',
        joiningDate: date(0),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: created.id,
        reason: 'Attempt inactive department assignment',
      }),
    ).rejects.toThrow('INVALID_STATE');
  });

  it('appends assignment history and rejects direct or indirect reporting cycles', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'A');
    const leader = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'LEAD-001',
        name: 'Team Lead',
        joiningDate: date(-3),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Company leader',
        reason: 'Create reporting leader',
      },
    );
    const member = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'MEM-001',
        name: 'Team Member',
        joiningDate: date(-2),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: leader.id,
        reason: 'Create reporting team member',
      },
    );
    await expect(
      createTenantEmployeeAssignment(
        runtime,
        actor(identities.hr),
        tenantId,
        leader.id,
        {
          expectedVersion: 1,
          effectiveFrom: date(2),
          ...refs,
          managerEmployeeId: member.id,
          reason: 'Attempt circular reporting line',
        },
      ),
    ).rejects.toThrow('INVALID_STATE');
    expect(
      await createTenantEmployeeAssignment(
        runtime,
        actor(identities.hr),
        tenantId,
        member.id,
        {
          expectedVersion: 1,
          effectiveFrom: date(2),
          ...refs,
          managerEmployeeId: null,
          topLevelReason: 'Approved independent team lead',
          reason: 'Promote employee to team lead',
        },
      ),
    ).toEqual({ id: member.id, version: 2 });
    const record = await readTenantEmployee(
      runtime,
      actor(identities.owner),
      tenantId,
      member.id,
    );
    expect(record.assignmentHistory).toHaveLength(2);
    expect(record.assignmentHistory[0]).toMatchObject({
      effectiveFrom: date(2),
      manager: null,
    });
    expect(record.assignmentHistory[1]).toMatchObject({
      effectiveTo: date(1),
      manager: { id: leader.id },
    });
    await expect(runtime.employeeAssignment.findMany()).rejects.toThrow();
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'employee.assignment_changed' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, aggregateId: member.id },
      }),
    ).toBe(2);
  });
});
