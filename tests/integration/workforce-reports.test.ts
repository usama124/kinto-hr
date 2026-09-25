import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  readTenantWorkforceHeadcountReport,
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
    'Workforce report tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let employeeIdentityId: string;
let otherOwnerId: string;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

type Fixture = {
  departmentIds: [string, string];
  employeeIds: string[];
};

async function createWorkforceFixture(
  selectedTenantId: string,
  selectedOwnerId: string,
  prefix: string,
): Promise<Fixture> {
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const designationId = randomUUID();
  const departmentIds: [string, string] = [randomUUID(), randomUUID()];
  await admin.legalEntity.create({
    data: {
      id: legalEntityId,
      tenantId: selectedTenantId,
      legalName: `${prefix} Synthetic Private Limited`,
      provinceCode: 'PK-PB',
    },
  });
  await admin.branch.create({
    data: {
      id: branchId,
      tenantId: selectedTenantId,
      legalEntityId,
      code: `${prefix}-LHR`,
      name: 'Lahore',
      provinceCode: 'PK-PB',
    },
  });
  await admin.department.createMany({
    data: [
      {
        id: departmentIds[0],
        tenantId: selectedTenantId,
        code: `${prefix}-ENG`,
        name: 'Engineering',
      },
      {
        id: departmentIds[1],
        tenantId: selectedTenantId,
        code: `${prefix}-OPS`,
        name: 'Operations',
      },
    ],
  });
  await admin.designation.create({
    data: {
      id: designationId,
      tenantId: selectedTenantId,
      code: `${prefix}-SWE`,
      name: 'Software Engineer',
    },
  });

  const employeeIds = [randomUUID(), randomUUID(), randomUUID()];
  await admin.employee.createMany({
    data: [
      {
        id: employeeIds[0],
        tenantId: selectedTenantId,
        employeeNumber: `${prefix}-001`,
        name: 'Active Employee',
        joiningDate: day('2026-09-01'),
        employmentType: 'monthly_salaried',
        status: 'active',
      },
      {
        id: employeeIds[1],
        tenantId: selectedTenantId,
        employeeNumber: `${prefix}-002`,
        name: 'Past Employee',
        joiningDate: day('2026-08-01'),
        employmentType: 'monthly_salaried',
        status: 'terminated',
      },
      {
        id: employeeIds[2],
        tenantId: selectedTenantId,
        employeeNumber: `${prefix}-003`,
        name: 'Draft Employee',
        joiningDate: day('2026-09-02'),
        employmentType: 'monthly_salaried',
        status: 'draft',
      },
    ],
  });
  const periodIds = [randomUUID(), randomUUID(), randomUUID()];
  await admin.employmentPeriod.createMany({
    data: [
      {
        id: periodIds[0],
        tenantId: selectedTenantId,
        employeeId: employeeIds[0],
        periodNumber: 1,
        joiningDate: day('2026-09-01'),
        status: 'active',
      },
      {
        id: periodIds[1],
        tenantId: selectedTenantId,
        employeeId: employeeIds[1],
        periodNumber: 1,
        joiningDate: day('2026-08-01'),
        finalWorkingDate: day('2026-09-15'),
        terminationScheduledByIdentityId: selectedOwnerId,
        terminationReason: 'Synthetic completed termination',
        terminationScheduledAt: new Date('2026-09-01T00:00:00.000Z'),
        status: 'ended',
      },
      {
        id: periodIds[2],
        tenantId: selectedTenantId,
        employeeId: employeeIds[2],
        periodNumber: 1,
        joiningDate: day('2026-09-02'),
        status: 'planned',
      },
    ],
  });
  await admin.employeeAssignment.createMany({
    data: employeeIds.map((employeeId, index) => ({
      id: randomUUID(),
      tenantId: selectedTenantId,
      employeeId,
      employmentPeriodId: periodIds[index],
      branchId,
      departmentId: departmentIds[index === 1 ? 1 : 0],
      designationId,
      managerEmployeeId: null,
      topLevelReason: 'Synthetic top-level role',
      effectiveFrom: day(index === 1 ? '2026-08-01' : `2026-09-0${index + 1}`),
      effectiveTo: index === 1 ? day('2026-09-15') : null,
      createdByIdentityId: selectedOwnerId,
    })),
  });
  return { departmentIds, employeeIds };
}

describe('tenant workforce headcount reports', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    employeeIdentityId = randomUUID();
    otherOwnerId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic report tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, employeeIdentityId, otherOwnerId].map((id) => ({
        id,
        issuer: 'https://reports.synthetic.example/realm',
        subject: randomUUID(),
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        {
          tenantId,
          identityId: employeeIdentityId,
          roles: ['employee'],
        },
        {
          tenantId: otherTenantId,
          identityId: otherOwnerId,
          roles: ['owner'],
        },
      ],
    });
  });

  afterEach(async () => {
    const tenants = [tenantId, otherTenantId];
    await admin.employeeAssignment.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employmentPeriod.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employee.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.designation.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.department.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.branch.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.legalEntity.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.membership.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.tenant.deleteMany({ where: { id: { in: tenants } } });
    await admin.identity.deleteMany({
      where: { id: { in: [ownerId, employeeIdentityId, otherOwnerId] } },
    });
  });

  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('counts effective employment periods and departments without draft records', async () => {
    const fixture = await createWorkforceFixture(tenantId, ownerId, 'ONE');
    await createWorkforceFixture(otherTenantId, otherOwnerId, 'TWO');
    const report = await readTenantWorkforceHeadcountReport(
      runtime,
      actor(ownerId),
      tenantId,
      {
        asOf: '2026-09-10',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      },
    );
    expect(report).toEqual({
      asOf: '2026-09-10',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      headcount: 2,
      joiners: 1,
      leavers: 1,
      departments: [
        {
          departmentId: fixture.departmentIds[0],
          departmentCode: 'ONE-ENG',
          departmentName: 'Engineering',
          headcount: 1,
        },
        {
          departmentId: fixture.departmentIds[1],
          departmentCode: 'ONE-OPS',
          departmentName: 'Operations',
          headcount: 1,
        },
      ],
      unassignedHeadcount: 0,
    });
    expect(JSON.stringify(report)).not.toMatch(/Active Employee|Past Employee/);
  });

  it('uses the selected as-of date and denies unauthorized or stale actors', async () => {
    await createWorkforceFixture(tenantId, ownerId, 'ONE');
    await expect(
      readTenantWorkforceHeadcountReport(
        runtime,
        actor(employeeIdentityId),
        tenantId,
        {
          asOf: '2026-09-20',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
        },
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readTenantWorkforceHeadcountReport(
        runtime,
        actor(ownerId, false),
        tenantId,
        {
          asOf: '2026-09-20',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
        },
      ),
    ).rejects.toThrow('FORBIDDEN');
    const later = await readTenantWorkforceHeadcountReport(
      runtime,
      actor(ownerId),
      tenantId,
      {
        asOf: '2026-09-20',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
      },
    );
    expect(later.headcount).toBe(1);
    await expect(
      runtime.$queryRaw`SELECT public.tenant_people_authorized(
        ${ownerId}::uuid, true, ${tenantId}::uuid, false
      )`,
    ).rejects.toThrow();
  });
});
