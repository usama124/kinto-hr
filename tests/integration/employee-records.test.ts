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
  readTenantEmployeePrivateDetails,
  readTenantEmployeeCompensation,
  readTenantEmployeeChecklist,
  readTenantEmployees,
  updateTenantEmployeePrivateDetails,
  reviseTenantEmployeeCompensation,
  createTenantEmployeeChecklistTask,
  completeTenantEmployeeChecklistTask,
  updateTenantEmployeeProfile,
  registerTenantEmployeeDocument,
  readTenantEmployeeDocuments,
  authorizeTenantEmployeeDocumentUpload,
  transitionTenantEmployeeDocumentScan,
  authorizeTenantEmployeeDocumentDownload,
  readTenantSelfEmployeeDocuments,
  authorizeTenantSelfEmployeeDocumentDownload,
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
let identities: Record<
  'owner' | 'hr' | 'payroll' | 'approver' | 'employee' | 'otherOwner',
  string
>;
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
      payroll: randomUUID(),
      approver: randomUUID(),
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
          tenantId,
          identityId: identities.payroll,
          roles: ['payroll_preparer'],
        },
        {
          tenantId,
          identityId: identities.approver,
          roles: ['payroll_approver'],
        },
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
    await admin.compensationComponentVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.salaryComponent.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.compensationAgreement.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.checklistTask.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeDocument.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeeAssignment.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.employeePrivateDetail.deleteMany({
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

  it('isolates versioned private details behind owner/HR permission and recent MFA', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'PRIVATE');
    const employee = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'PRIVATE-001',
        name: 'Private Details Fixture',
        joiningDate: date(-1),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Approved top-level fixture',
        reason: 'Create private details fixture',
      },
    );
    expect(
      await readTenantEmployeePrivateDetails(
        runtime,
        actor(identities.owner),
        tenantId,
        employee.id,
      ),
    ).toEqual({ details: null });
    const input = {
      expectedVersion: 0,
      personalEmail: 'private@example.com',
      mobilePhone: '+923001234567',
      residentialAddress: 'Synthetic Lahore address',
      emergencyContactName: 'Synthetic Emergency Contact',
      emergencyContactPhone: '03007654321',
      cnic: '3520212345671',
      reason: 'Approved synthetic private details',
    };
    expect(
      await updateTenantEmployeePrivateDetails(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        input,
      ),
    ).toMatchObject({ version: 1 });
    const result = await readTenantEmployeePrivateDetails(
      runtime,
      actor(identities.owner),
      tenantId,
      employee.id,
    );
    expect(result.details).toMatchObject({
      version: 1,
      personalEmail: input.personalEmail,
      cnic: input.cnic,
    });
    const publicRecord = await readTenantEmployee(
      runtime,
      actor(identities.owner),
      tenantId,
      employee.id,
    );
    expect(JSON.stringify(publicRecord)).not.toContain(input.personalEmail);
    expect(JSON.stringify(publicRecord)).not.toContain(input.cnic);

    for (const deniedActor of [
      actor(identities.hr, false),
      actor(identities.employee),
      actor(identities.payroll),
      actor(identities.otherOwner),
    ]) {
      await expect(
        readTenantEmployeePrivateDetails(
          runtime,
          deniedActor,
          tenantId,
          employee.id,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(
      updateTenantEmployeePrivateDetails(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        input,
      ),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect(
      await updateTenantEmployeePrivateDetails(
        runtime,
        actor(identities.owner),
        tenantId,
        employee.id,
        { ...input, expectedVersion: 1, reason: 'Approved contact refresh' },
      ),
    ).toMatchObject({ version: 2 });
    await expect(runtime.employeePrivateDetail.findMany()).rejects.toThrow();

    const audit = await admin.auditEvent.findMany({
      where: {
        tenantId,
        action: { startsWith: 'employee.private_details_' },
      },
    });
    const outbox = await admin.outboxEvent.findMany({
      where: { tenantId, type: 'employee.private_details_changed.v1' },
    });
    expect(audit).toHaveLength(2);
    expect(outbox).toHaveLength(2);
    expect(JSON.stringify({ audit, outbox })).not.toContain(input.cnic);
    expect(JSON.stringify({ audit, outbox })).not.toContain(
      input.personalEmail,
    );
  });

  it('registers isolated retry-safe document metadata without exposing storage secrets', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'DOC');
    const employee = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'DOC-001',
        name: 'Document Fixture',
        joiningDate: date(-1),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Approved top-level fixture',
        reason: 'Create document fixture',
      },
    );
    const requestKey = randomUUID();
    const input = {
      category: 'employment' as const,
      visibility: 'hr_only' as const,
      fileName: 'Synthetic contract.pdf',
      contentType: 'application/pdf' as const,
      sizeBytes: 2048,
      fileDigest: 'a'.repeat(64),
      expiresOn: null,
      replacementDocumentId: null,
      reason: 'Register approved synthetic document',
    };
    const registered = await registerTenantEmployeeDocument(
      runtime,
      actor(identities.hr),
      tenantId,
      employee.id,
      requestKey,
      input,
    );
    expect(registered).toMatchObject({
      employeeId: employee.id,
      status: 'awaiting_upload',
      fileName: input.fileName,
    });
    expect(JSON.stringify(registered)).not.toMatch(/digest|storage|objectKey/i);
    expect(
      await registerTenantEmployeeDocument(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        requestKey,
        input,
      ),
    ).toEqual(registered);
    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([
      registerTenantEmployeeDocument(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        concurrentKey,
        input,
      ),
      registerTenantEmployeeDocument(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        concurrentKey,
        input,
      ),
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    await expect(
      registerTenantEmployeeDocument(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        requestKey,
        { ...input, fileDigest: 'b'.repeat(64) },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const otherEmployee = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'DOC-002',
        name: 'Other Document Fixture',
        joiningDate: date(-1),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Approved top-level fixture',
        reason: 'Create another document fixture',
      },
    );
    await expect(
      registerTenantEmployeeDocument(
        runtime,
        actor(identities.hr),
        tenantId,
        otherEmployee.id,
        randomUUID(),
        { ...input, replacementDocumentId: registered.id },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      await readTenantEmployeeDocuments(
        runtime,
        actor(identities.owner),
        tenantId,
        employee.id,
      ),
    ).toEqual({
      documents: expect.arrayContaining([registered, concurrent[0]]),
    });
    for (const denied of [
      actor(identities.hr, false),
      actor(identities.employee),
      actor(identities.payroll),
      actor(identities.otherOwner),
    ])
      await expect(
        readTenantEmployeeDocuments(runtime, denied, tenantId, employee.id),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.employeeDocument.findMany()).rejects.toThrow();
    const stored = await admin.employeeDocument.findUniqueOrThrow({
      where: { id: registered.id },
    });
    expect(stored.storageObjectKey).toMatch(/^[a-f0-9]{2}\/[a-f0-9-]{36}$/);
    expect(stored.contentDigest).toBe(input.fileDigest);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'employee.document_registered' },
      }),
    ).toBe(2);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'employee.document_registered.v1' },
      }),
    ).toBe(2);
    const upload = await authorizeTenantEmployeeDocumentUpload(
      runtime,
      actor(identities.hr),
      tenantId,
      employee.id,
      registered.id,
    );
    expect(upload).toMatchObject({
      status: 'awaiting_upload',
      fileDigest: input.fileDigest,
      sizeBytes: input.sizeBytes,
    });
    await expect(
      authorizeTenantEmployeeDocumentDownload(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const denied of [
      actor(identities.hr, false),
      actor(identities.employee),
      actor(identities.otherOwner),
    ])
      await expect(
        authorizeTenantEmployeeDocumentUpload(
          runtime,
          denied,
          tenantId,
          employee.id,
          registered.id,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      transitionTenantEmployeeDocumentScan(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
        'quarantined',
        'clean',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(
      await transitionTenantEmployeeDocumentScan(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
        'awaiting_upload',
        'quarantined',
      ),
    ).toMatchObject({ status: 'quarantined', scannedAt: null });
    const clean = await transitionTenantEmployeeDocumentScan(
      runtime,
      actor(identities.hr),
      tenantId,
      employee.id,
      registered.id,
      'quarantined',
      'clean',
    );
    expect(clean).toMatchObject({ status: 'clean' });
    expect(clean.scannedAt).not.toBeNull();
    expect(
      await authorizeTenantEmployeeDocumentDownload(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
      ),
    ).toEqual({
      storageObjectKey: stored.storageObjectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      fileDigest: input.fileDigest,
    });
    for (const denied of [
      actor(identities.hr, false),
      actor(identities.employee),
      actor(identities.otherOwner),
    ])
      await expect(
        authorizeTenantEmployeeDocumentDownload(
          runtime,
          denied,
          tenantId,
          employee.id,
          registered.id,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      authorizeTenantEmployeeDocumentDownload(
        runtime,
        actor(identities.hr),
        tenantId,
        otherEmployee.id,
        registered.id,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'employee.document_download_authorized' },
      }),
    ).toBe(1);
    await admin.employeeDocument.update({
      where: { id: registered.id },
      data: { expiresOn: new Date(`${date(-1)}T00:00:00.000Z`) },
    });
    await expect(
      authorizeTenantEmployeeDocumentDownload(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await admin.employeeDocument.update({
      where: { id: registered.id },
      data: { expiresOn: null },
    });
    await expect(
      authorizeTenantEmployeeDocumentUpload(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await admin.membership.updateMany({
      where: { tenantId, identityId: identities.hr },
      data: { status: 'revoked' },
    });
    await expect(
      authorizeTenantEmployeeDocumentDownload(
        runtime,
        actor(identities.hr),
        tenantId,
        employee.id,
        registered.id,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows only own clean employee-visible documents through an active identity link', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'SELF');
    const employee = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'SELF-001',
        name: 'Linked Employee',
        joiningDate: date(-1),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Approved top-level fixture',
        reason: 'Create self-document fixture',
      },
    );
    const otherEmployee = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'SELF-002',
        name: 'Other Employee',
        joiningDate: date(-1),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Approved top-level fixture',
        reason: 'Create other self-document fixture',
      },
    );
    const member = await admin.membership.findFirstOrThrow({
      where: { tenantId, identityId: identities.employee },
    });
    const requestId = randomUUID();
    const invitationId = randomUUID();
    await admin.employeeAccountRequest.create({
      data: {
        id: requestId,
        requestKey: randomUUID(),
        tenantId,
        employeeId: employee.id,
        requestedByIdentityId: identities.owner,
        email: 'linked-synthetic@example.com',
        status: 'active',
      },
    });
    await admin.employeeInvitation.create({
      data: {
        id: invitationId,
        requestId,
        tenantId,
        employeeId: employee.id,
        identityId: identities.employee,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await admin.employeeIdentityLink.create({
      data: {
        id: randomUUID(),
        tenantId,
        employeeId: employee.id,
        identityId: identities.employee,
        membershipId: member.id,
        invitationId,
      },
    });
    const input = {
      category: 'employment' as const,
      visibility: 'employee_visible' as const,
      fileName: 'Visible.pdf',
      contentType: 'application/pdf' as const,
      sizeBytes: 2048,
      fileDigest: 'a'.repeat(64),
      expiresOn: null,
      replacementDocumentId: null,
      reason: 'Register synthetic visible file',
    };
    const register = async (
      ownerEmployeeId: string,
      override: {
        visibility?: 'hr_only' | 'employee_visible';
        expiresOn?: string | null;
      } = {},
    ) =>
      registerTenantEmployeeDocument(
        runtime,
        actor(identities.hr),
        tenantId,
        ownerEmployeeId,
        randomUUID(),
        { ...input, ...override },
      );
    const clean = async (ownerEmployeeId: string, documentId: string) => {
      await transitionTenantEmployeeDocumentScan(
        runtime,
        actor(identities.hr),
        tenantId,
        ownerEmployeeId,
        documentId,
        'awaiting_upload',
        'quarantined',
      );
      await transitionTenantEmployeeDocumentScan(
        runtime,
        actor(identities.hr),
        tenantId,
        ownerEmployeeId,
        documentId,
        'quarantined',
        'clean',
      );
    };
    const visible = await register(employee.id);
    await clean(employee.id, visible.id);
    const hrOnly = await register(employee.id, { visibility: 'hr_only' });
    await clean(employee.id, hrOnly.id);
    const pending = await register(employee.id);
    const expired = await register(employee.id, { expiresOn: date(-1) });
    await clean(employee.id, expired.id);
    const another = await register(otherEmployee.id);
    await clean(otherEmployee.id, another.id);
    const selfDocuments = await readTenantSelfEmployeeDocuments(
      runtime,
      actor(identities.employee),
      tenantId,
    );
    expect(selfDocuments.documents).toEqual([
      expect.objectContaining({ id: visible.id, status: 'clean' }),
    ]);
    const target = await authorizeTenantSelfEmployeeDocumentDownload(
      runtime,
      actor(identities.employee),
      tenantId,
      visible.id,
    );
    expect(target).toMatchObject({
      contentType: input.contentType,
      fileDigest: input.fileDigest,
    });
    expect(JSON.stringify(selfDocuments)).not.toContain(
      target.storageObjectKey,
    );
    for (const hidden of [hrOnly, pending, expired, another])
      await expect(
        authorizeTenantSelfEmployeeDocumentDownload(
          runtime,
          actor(identities.employee),
          tenantId,
          hidden.id,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const denied of [
      actor(identities.employee, false),
      actor(identities.hr),
      actor(identities.otherOwner),
    ])
      await expect(
        readTenantSelfEmployeeDocuments(runtime, denied, tenantId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      readTenantSelfEmployeeDocuments(
        runtime,
        actor(identities.employee),
        otherTenantId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.membership.update({
      where: { id: member.id },
      data: { status: 'revoked' },
    });
    await expect(
      authorizeTenantSelfEmployeeDocumentDownload(
        runtime,
        actor(identities.employee),
        tenantId,
        visible.id,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await admin.auditEvent.count({
        where: {
          tenantId,
          action: 'employee.document_self_download_authorized',
        },
      }),
    ).toBe(1);
  });

  it('retains effective compensation revisions behind explicit payroll roles', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'PAY');
    const joiningDate = date(-2);
    const employee = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'PAY-001',
        name: 'Compensation Fixture',
        joiningDate,
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Approved top-level fixture',
        reason: 'Create compensation fixture',
      },
    );
    expect(
      await readTenantEmployeeCompensation(
        runtime,
        actor(identities.approver),
        tenantId,
        employee.id,
      ),
    ).toEqual({ agreement: null });
    const initial = {
      expectedAgreementVersion: 0,
      effectiveFrom: joiningDate,
      components: [
        {
          code: 'BASIC',
          name: 'Monthly basic salary',
          kind: 'basic_salary' as const,
          monthlyAmount: '100000.00',
        },
        {
          code: 'TRANSPORT',
          name: 'Transport allowance',
          kind: 'allowance' as const,
          monthlyAmount: '5000',
        },
      ],
      reason: 'Approved initial compensation',
    };
    expect(
      await reviseTenantEmployeeCompensation(
        runtime,
        actor(identities.payroll),
        tenantId,
        employee.id,
        initial,
      ),
    ).toMatchObject({ version: 1 });
    const incrementDate = date(10);
    expect(
      await reviseTenantEmployeeCompensation(
        runtime,
        actor(identities.payroll),
        tenantId,
        employee.id,
        {
          ...initial,
          expectedAgreementVersion: 1,
          effectiveFrom: incrementDate,
          components: [
            { ...initial.components[0], monthlyAmount: '110000.00' },
            ...initial.components.slice(1),
          ],
          reason: 'Approved future salary increment',
        },
      ),
    ).toMatchObject({ version: 2 });
    const history = await readTenantEmployeeCompensation(
      runtime,
      actor(identities.approver),
      tenantId,
      employee.id,
    );
    expect(history.agreement).toMatchObject({
      employeeId: employee.id,
      currencyCode: 'PKR',
      version: 2,
    });
    expect(history.agreement?.revisions).toHaveLength(2);
    expect(history.agreement?.revisions[0]).toMatchObject({
      revision: 2,
      effectiveFrom: incrementDate,
      effectiveTo: null,
    });
    expect(history.agreement?.revisions[0].components).toContainEqual(
      expect.objectContaining({ code: 'BASIC', monthlyAmount: '110000.00' }),
    );
    expect(history.agreement?.revisions[1]).toMatchObject({
      revision: 1,
      effectiveFrom: joiningDate,
      effectiveTo: date(9),
    });
    const publicRecord = await readTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      employee.id,
    );
    expect(publicRecord.payrollSetup).toBe('complete');
    expect(JSON.stringify(publicRecord)).not.toContain('110000');

    for (const denied of [
      actor(identities.owner),
      actor(identities.hr),
      actor(identities.employee),
      actor(identities.payroll, false),
      actor(identities.otherOwner),
    ])
      await expect(
        readTenantEmployeeCompensation(runtime, denied, tenantId, employee.id),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reviseTenantEmployeeCompensation(
        runtime,
        actor(identities.approver),
        tenantId,
        employee.id,
        { ...initial, expectedAgreementVersion: 2, effectiveFrom: date(20) },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      reviseTenantEmployeeCompensation(
        runtime,
        actor(identities.payroll),
        tenantId,
        employee.id,
        {
          ...initial,
          expectedAgreementVersion: 2,
          effectiveFrom: incrementDate,
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runtime.compensationAgreement.findMany()).rejects.toThrow();
    await expect(runtime.salaryComponent.findMany()).rejects.toThrow();
    await expect(
      runtime.compensationComponentVersion.findMany(),
    ).rejects.toThrow();

    const audit = await admin.auditEvent.findMany({
      where: { tenantId, action: { startsWith: 'employee.compensation_' } },
    });
    const outbox = await admin.outboxEvent.findMany({
      where: { tenantId, type: 'employee.compensation_changed.v1' },
    });
    expect(audit).toHaveLength(2);
    expect(outbox).toHaveLength(2);
    expect(JSON.stringify({ audit, outbox })).not.toContain('110000');
  });

  it('versions tenant-scoped onboarding tasks without exposing workflow writes to payroll', async () => {
    const refs = await setupOrganization(tenantId, identities.owner, 'CL');
    const created = await createTenantEmployee(
      runtime,
      actor(identities.hr),
      tenantId,
      {
        employeeNumber: 'EMP-CL-001',
        name: 'Checklist Employee',
        joiningDate: date(0),
        employmentType: 'monthly_salaried',
        ...refs,
        managerEmployeeId: null,
        topLevelReason: 'Company leadership role',
        reason: 'Create checklist fixture',
      },
    );
    const task = await createTenantEmployeeChecklistTask(
      runtime,
      actor(identities.owner),
      tenantId,
      created.id,
      {
        lifecycle: 'onboarding',
        taskCode: ' collect_documents ',
        title: 'Collect signed documents',
        assigneeIdentityId: identities.hr,
        dueDate: date(2),
        reason: 'Prepare employee onboarding',
      },
    );
    expect(task.version).toBe(1);
    await expect(
      createTenantEmployeeChecklistTask(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
        {
          lifecycle: 'onboarding',
          taskCode: 'COLLECT_DOCUMENTS',
          title: 'Duplicate task',
          assigneeIdentityId: identities.owner,
          dueDate: date(2),
          reason: 'Attempt duplicate checklist task',
        },
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      readTenantEmployeeChecklist(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
      ),
    ).resolves.toMatchObject({
      tasks: [
        {
          id: task.id,
          lifecycle: 'onboarding',
          taskCode: 'COLLECT_DOCUMENTS',
          assigneeIdentityId: identities.hr,
          status: 'pending',
          version: 1,
        },
      ],
    });
    await expect(
      completeTenantEmployeeChecklistTask(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
        task.id,
        { expectedVersion: 1, reason: 'Documents verified' },
      ),
    ).resolves.toEqual({ id: task.id, version: 2 });
    await expect(
      completeTenantEmployeeChecklistTask(
        runtime,
        actor(identities.hr),
        tenantId,
        created.id,
        task.id,
        { expectedVersion: 1, reason: 'Repeat completion' },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      readTenantEmployeeChecklist(
        runtime,
        actor(identities.payroll),
        tenantId,
        created.id,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readTenantEmployeeChecklist(
        runtime,
        actor(identities.owner, false),
        tenantId,
        created.id,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(runtime.checklistTask.findMany()).rejects.toThrow();
    await expect(
      admin.auditEvent.findMany({
        where: { tenantId, resourceId: task.id },
      }),
    ).resolves.toHaveLength(2);
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
