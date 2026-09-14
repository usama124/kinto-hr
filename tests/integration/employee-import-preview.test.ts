import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createTenantBranch,
  createTenantEmployee,
  createTenantEmployeeImportPreview,
  createTenantLegalEntity,
  createTenantOrganizationCatalogEntry,
  readTenantEmployeeImportPreview,
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
    'Employee import tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let hrId: string;
let payrollId: string;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const header =
  'employee_number,display_name,legal_name,joining_date,branch_code,department_code,designation_code,manager_employee_number,top_level_reason';

describe('tenant employee CSV import preview', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    hrId = randomUUID();
    payrollId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic import tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, hrId, payrollId].map((id) => ({
        id,
        issuer: 'https://imports.synthetic.example/realm',
        subject: randomUUID(),
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        { tenantId, identityId: hrId, roles: ['hr_admin'] },
        { tenantId, identityId: payrollId, roles: ['payroll_preparer'] },
      ],
    });
    await createTenantLegalEntity(runtime, actor(ownerId), tenantId, {
      legalName: 'Synthetic Import Employer Private Limited',
      provinceCode: 'PK-PB',
      reason: 'Create import fixture employer',
    });
    await createTenantBranch(runtime, actor(ownerId), tenantId, {
      code: 'LHR',
      name: 'Lahore Office',
      provinceCode: 'PK-PB',
      reason: 'Create import fixture branch',
    });
    await createTenantOrganizationCatalogEntry(
      runtime,
      actor(ownerId),
      tenantId,
      'department',
      { code: 'ENG', name: 'Engineering', reason: 'Create import department' },
    );
    await createTenantOrganizationCatalogEntry(
      runtime,
      actor(ownerId),
      tenantId,
      'designation',
      {
        code: 'SWE',
        name: 'Software Engineer',
        reason: 'Create import designation',
      },
    );
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
    await admin.employeeImportRow.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeImportBatch.deleteMany({
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
      where: { id: { in: [ownerId, hrId, payrollId] } },
    });
  });
  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('stores a digest-backed valid preview without creating employees', async () => {
    const content = `${header}\nEMP-001,Sana Khan,,2026-09-14,LHR,ENG,SWE,,Company leader`;
    const requestKey = randomUUID();
    const input = {
      fileName: 'employees.csv',
      content,
      reason: 'Preview employee migration',
    };
    const preview = await createTenantEmployeeImportPreview(
      runtime,
      actor(hrId),
      tenantId,
      requestKey,
      input,
    );
    expect(preview).toMatchObject({
      fileName: 'employees.csv',
      fileDigest: createHash('sha256').update(content).digest('hex'),
      previewRevision: 1,
      status: 'ready',
      rowCount: 1,
      errorCount: 0,
      rows: [
        { rowNumber: 2, errors: [], values: { employeeNumber: 'EMP-001' } },
      ],
    });
    expect(await admin.employee.count({ where: { tenantId } })).toBe(0);
    await expect(
      createTenantEmployeeImportPreview(
        runtime,
        actor(hrId),
        tenantId,
        requestKey,
        input,
      ),
    ).resolves.toEqual(preview);
    expect(await admin.employeeImportBatch.count({ where: { tenantId } })).toBe(
      1,
    );
    await expect(
      createTenantEmployeeImportPreview(
        runtime,
        actor(hrId),
        tenantId,
        requestKey,
        { ...input, reason: 'Changed request with reused key' },
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      readTenantEmployeeImportPreview(
        runtime,
        actor(ownerId),
        tenantId,
        preview.id,
      ),
    ).resolves.toEqual(preview);
    await expect(runtime.employeeImportBatch.findMany()).rejects.toThrow();
    await expect(runtime.employeeImportRow.findMany()).rejects.toThrow();
    await expect(
      admin.auditEvent.findFirstOrThrow({
        where: {
          tenantId,
          resourceId: preview.id,
          action: 'employee.import_previewed',
        },
      }),
    ).resolves.toMatchObject({ reason: 'Preview employee migration' });
  });

  it('returns row-numbered reference, duplicate and formula errors', async () => {
    const existing = await createTenantEmployee(
      runtime,
      actor(hrId),
      tenantId,
      {
        employeeNumber: 'EMP-EXISTING',
        name: 'Existing Employee',
        joiningDate: '2026-09-01',
        employmentType: 'monthly_salaried',
        branchId: (await admin.branch.findFirstOrThrow({ where: { tenantId } }))
          .id,
        departmentId: (
          await admin.department.findFirstOrThrow({ where: { tenantId } })
        ).id,
        designationId: (
          await admin.designation.findFirstOrThrow({ where: { tenantId } })
        ).id,
        managerEmployeeId: null,
        topLevelReason: 'Company leader',
        reason: 'Create duplicate import fixture',
      },
    );
    expect(existing.id).toBeTruthy();
    const content = `${header}\nEMP-EXISTING,Duplicate,,2026-09-14,UNKNOWN,ENG,SWE,,Company leader\nEMP-002,=CMD(),,bad,LHR,ENG,SWE,UNKNOWN,`;
    const preview = await createTenantEmployeeImportPreview(
      runtime,
      actor(ownerId),
      tenantId,
      randomUUID(),
      { fileName: 'invalid.csv', content, reason: 'Validate bad import rows' },
    );
    expect(preview.status).toBe('invalid');
    expect(preview.errorCount).toBeGreaterThanOrEqual(4);
    expect(preview.rows[0].errors).toEqual(
      expect.arrayContaining([
        { field: 'employeeNumber', code: 'duplicate_employee_number' },
        { field: 'branchCode', code: 'unknown_branch' },
      ]),
    );
    expect(preview.rows[1].errors).toEqual(
      expect.arrayContaining([
        { field: 'name', code: 'spreadsheet_formula' },
        { field: 'joiningDate', code: 'invalid_value' },
      ]),
    );
    expect(await admin.employee.count({ where: { tenantId } })).toBe(1);
  });

  it('persists physical row numbers beyond blank CSV lines', async () => {
    const content = `${header}${'\n'.repeat(300)}EMP-003,Ayesha Khan,,2026-09-16,LHR,ENG,SWE,,Company leader`;
    const preview = await createTenantEmployeeImportPreview(
      runtime,
      actor(hrId),
      tenantId,
      randomUUID(),
      {
        fileName: 'employees-with-blanks.csv',
        content,
        reason: 'Verify physical import row numbers',
      },
    );
    expect(preview).toMatchObject({
      status: 'ready',
      rowCount: 1,
      rows: [{ rowNumber: 301, errors: [] }],
    });
  });

  it('denies missing MFA, payroll-only and cross-tenant preview access', async () => {
    const input = {
      fileName: 'employees.csv',
      content: `${header}\nEMP-001,Sana Khan,,2026-09-14,LHR,ENG,SWE,,Company leader`,
      reason: 'Preview employee migration',
    };
    await expect(
      createTenantEmployeeImportPreview(
        runtime,
        actor(hrId, false),
        tenantId,
        randomUUID(),
        input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      createTenantEmployeeImportPreview(
        runtime,
        actor(payrollId),
        tenantId,
        randomUUID(),
        input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    const preview = await createTenantEmployeeImportPreview(
      runtime,
      actor(ownerId),
      tenantId,
      randomUUID(),
      input,
    );
    await expect(
      readTenantEmployeeImportPreview(
        runtime,
        actor(ownerId),
        otherTenantId,
        preview.id,
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
});
