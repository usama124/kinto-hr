import { expect, it } from 'vitest';
import {
  authenticatedIdentitySchema,
  tenantRoleSchema,
  employeeDraftSchema,
  healthSchema,
  tenantIdSchema,
  tenantSelectionSchema,
  companyProvisioningSchema,
  entitlementSnapshotSchema,
  employeeAccountProvisioningSchema,
  membershipRoleUpdateSchema,
  membershipRevocationSchema,
  administratorInvitationSchema,
  securityAuditQuerySchema,
  legalEntityCreateSchema,
  legalEntityUpdateSchema,
  branchCreateSchema,
  branchUpdateSchema,
  organizationCatalogCreateSchema,
  organizationCatalogUpdateSchema,
  organizationPolicyDraftSchema,
  organizationPolicyPublishSchema,
  entitlementChangeSchema,
  entitlementRevocationSchema,
  employeeRecordCreateSchema,
  employeeProfileUpdateSchema,
  employeeActivationSchema,
  employeeTerminationSchema,
  employeeArchiveSchema,
  employeeRehireSchema,
  employeePrivateDetailsUpdateSchema,
  employeeCompensationRevisionSchema,
  employeeChecklistTaskCreateSchema,
  employeeChecklistTaskCompletionSchema,
  employeeImportUploadSchema,
  employeeImportConfirmationSchema,
  employeeDocumentRegistrationSchema,
  parseEmployeeImportCsv,
  employeeAssignmentCreateSchema,
} from './index';
it('trims names while preserving employee identifiers as strings', () => {
  expect(
    employeeDraftSchema.parse({ employeeNumber: '0012', name: ' Sana Khan ' }),
  ).toEqual({ employeeNumber: '0012', name: 'Sana Khan' });
});

it('accepts bounded private document metadata and rejects unsafe file contracts', () => {
  const input = {
    category: 'employment' as const,
    visibility: 'hr_only' as const,
    fileName: ' Signed contract.pdf ',
    contentType: 'application/pdf' as const,
    sizeBytes: 1024,
    fileDigest: 'a'.repeat(64),
    expiresOn: null,
    replacementDocumentId: null,
    reason: 'Approved employment document',
  };
  expect(employeeDocumentRegistrationSchema.parse(input).fileName).toBe(
    'Signed contract.pdf',
  );
  expect(
    employeeDocumentRegistrationSchema.safeParse({
      ...input,
      contentType: 'text/html',
    }).success,
  ).toBe(false);
  expect(
    employeeDocumentRegistrationSchema.safeParse({
      ...input,
      sizeBytes: 10 * 1024 * 1024 + 1,
    }).success,
  ).toBe(false);
  expect(
    employeeDocumentRegistrationSchema.safeParse({
      ...input,
      storageObjectKey: 'forged/key',
    }).success,
  ).toBe(false);
  expect(
    employeeDocumentRegistrationSchema.safeParse({
      ...input,
      fileName: '../identity.pdf',
    }).success,
  ).toBe(false);
});

it('normalizes private employee details and rejects incomplete emergency or payroll data', () => {
  expect(
    employeePrivateDetailsUpdateSchema.parse({
      expectedVersion: 0,
      personalEmail: ' PERSON@Example.COM ',
      mobilePhone: '+92 300-1234567',
      residentialAddress: 'Lahore, Pakistan',
      emergencyContactName: 'Emergency Contact',
      emergencyContactPhone: '0300 7654321',
      cnic: '35202-1234567-1',
      reason: 'Initial employee private details',
    }),
  ).toMatchObject({
    personalEmail: 'person@example.com',
    mobilePhone: '+923001234567',
    emergencyContactPhone: '03007654321',
    cnic: '3520212345671',
  });
  expect(
    employeePrivateDetailsUpdateSchema.safeParse({
      expectedVersion: 1,
      personalEmail: null,
      mobilePhone: null,
      residentialAddress: null,
      emergencyContactName: 'Emergency Contact',
      emergencyContactPhone: null,
      cnic: null,
      reason: 'Invalid partial emergency contact',
    }).success,
  ).toBe(false);
  expect(
    employeePrivateDetailsUpdateSchema.safeParse({
      expectedVersion: 1,
      personalEmail: 'person@example.com',
      mobilePhone: null,
      residentialAddress: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      cnic: null,
      bankAccount: 'PK00FORBIDDEN',
      reason: 'Reject payroll data in private profile',
    }).success,
  ).toBe(false);
});
it('accepts one typed basic salary and rejects ambiguous compensation snapshots', () => {
  expect(
    employeeCompensationRevisionSchema.parse({
      expectedAgreementVersion: 0,
      effectiveFrom: '2026-09-01',
      components: [
        {
          code: ' basic ',
          name: 'Monthly basic salary',
          kind: 'basic_salary',
          monthlyAmount: '100000.00',
        },
        {
          code: 'transport',
          name: 'Transport allowance',
          kind: 'allowance',
          monthlyAmount: '5000',
        },
      ],
      reason: 'Approved initial compensation',
    }),
  ).toMatchObject({
    components: [{ code: 'BASIC' }, { code: 'TRANSPORT' }],
  });
  for (const components of [
    [
      {
        code: 'ALLOWANCE',
        name: 'Allowance only',
        kind: 'allowance',
        monthlyAmount: '100',
      },
    ],
    [
      {
        code: 'BASIC',
        name: 'Basic one',
        kind: 'basic_salary',
        monthlyAmount: '100',
      },
      {
        code: 'BASIC',
        name: 'Basic duplicate',
        kind: 'basic_salary',
        monthlyAmount: '200',
      },
    ],
    [
      {
        code: 'BASIC',
        name: 'Zero basic',
        kind: 'basic_salary',
        monthlyAmount: '0.00',
      },
    ],
  ])
    expect(
      employeeCompensationRevisionSchema.safeParse({
        expectedAgreementVersion: 0,
        effectiveFrom: '2026-09-01',
        components,
        reason: 'Invalid compensation snapshot',
      }).success,
    ).toBe(false);
});
it('normalizes checklist codes and rejects unrecognized task fields', () => {
  expect(
    employeeChecklistTaskCreateSchema.parse({
      lifecycle: 'onboarding',
      taskCode: ' collect_documents ',
      title: ' Collect signed documents ',
      assigneeIdentityId: crypto.randomUUID(),
      dueDate: '2026-09-20',
      reason: 'Prepare employee onboarding',
    }),
  ).toMatchObject({
    taskCode: 'COLLECT_DOCUMENTS',
    title: 'Collect signed documents',
  });
  expect(
    employeeChecklistTaskCreateSchema.safeParse({
      lifecycle: 'onboarding',
      taskCode: 'COLLECT-DOCUMENTS',
      title: 'Collect signed documents',
      assigneeIdentityId: crypto.randomUUID(),
      dueDate: '2026-09-20',
      reason: 'Prepare employee onboarding',
    }).success,
  ).toBe(false);
  expect(
    employeeChecklistTaskCompletionSchema.safeParse({
      expectedVersion: 1,
      reason: 'Documents verified',
      completedByIdentityId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
});
it('parses the fixed employee CSV template with physical row numbers', () => {
  const header =
    'employee_number,display_name,legal_name,joining_date,branch_code,department_code,designation_code,manager_employee_number,top_level_reason';
  const result = parseEmployeeImportCsv(
    `${header}\r\nEMP-001,"Sana,\nKhan",,2026-09-14,LHR-01,ENG,SWE,,Company leader\r\n\r\nEMP-002,Ali Khan,,2026-09-15,LHR-01,ENG,SWE,EMP-001,`,
  );
  expect(result.fileErrors).toEqual([]);
  expect(result.rows).toMatchObject([
    {
      rowNumber: 2,
      values: { employeeNumber: 'EMP-001', name: 'Sana,\nKhan' },
      errors: [],
    },
    {
      rowNumber: 5,
      values: {
        employeeNumber: 'EMP-002',
        managerEmployeeNumber: 'EMP-001',
      },
      errors: [],
    },
  ]);
  expect(
    employeeImportUploadSchema.safeParse({
      fileName: '../employees.csv',
      content: header,
      reason: 'Preview employee import',
    }).success,
  ).toBe(false);
  expect(
    employeeImportUploadSchema.safeParse({
      fileName: 'employees.csv',
      content: 'é'.repeat(40_000),
      reason: 'Preview employee import',
    }).success,
  ).toBe(false);
  const afterBlankLines = parseEmployeeImportCsv(
    `${header}${'\n'.repeat(300)}EMP-003,Ayesha Khan,,2026-09-16,LHR-01,ENG,SWE,,Company leader`,
  );
  expect(afterBlankLines.fileErrors).toEqual([]);
  expect(afterBlankLines.rows).toMatchObject([{ rowNumber: 301 }]);
});

it('reports malformed, duplicate and spreadsheet-formula CSV values', () => {
  const header =
    'employee_number,display_name,legal_name,joining_date,branch_code,department_code,designation_code,manager_employee_number,top_level_reason';
  const parsed = parseEmployeeImportCsv(
    `${header}\nEMP-001,=CMD(),,bad-date,LHR,ENG,SWE,,ok\nEMP-001,Second Person,,2026-09-14,LHR,ENG,SWE,,Top level`,
  );
  expect(parsed.rows[0].errors).toEqual(
    expect.arrayContaining([
      { field: 'name', code: 'spreadsheet_formula' },
      { field: 'joiningDate', code: 'invalid_value' },
    ]),
  );
  expect(parsed.rows[1].errors).toContainEqual({
    field: 'employeeNumber',
    code: 'duplicate_employee_number',
  });
  expect(parseEmployeeImportCsv('wrong,headers').fileErrors).toEqual([
    { field: 'headers', code: 'invalid_headers' },
  ]);
  expect(parseEmployeeImportCsv(`${header}\n"unterminated`).fileErrors).toEqual(
    [{ field: 'file', code: 'malformed_csv' }],
  );
  expect(parseEmployeeImportCsv(`${header}\n"closed"junk`).fileErrors).toEqual([
    { field: 'file', code: 'malformed_csv' },
  ]);
});
it('requires an exact immutable employee import confirmation reference', () => {
  const input = {
    previewRevision: 1,
    fileDigest: 'a'.repeat(64),
    reason: 'Approve validated employee import',
  };
  expect(employeeImportConfirmationSchema.parse(input)).toEqual(input);
  expect(
    employeeImportConfirmationSchema.safeParse({ ...input, activate: false })
      .success,
  ).toBe(false);
  expect(
    employeeImportConfirmationSchema.safeParse({
      ...input,
      previewRevision: 0,
    }).success,
  ).toBe(false);
});
it('accepts only explicit administrator invitation authority', () => {
  expect(
    administratorInvitationSchema.parse({
      email: ' Admin@Example.COM ',
      roles: ['payroll_approver', 'hr_admin'],
      reason: 'Approved operational access',
    }),
  ).toEqual({
    email: 'admin@example.com',
    roles: ['hr_admin', 'payroll_approver'],
    reason: 'Approved operational access',
  });
  for (const input of [
    { email: 'admin@example.com', roles: ['employee'], reason: 'Invalid role' },
    {
      email: 'admin@example.com',
      roles: ['owner', 'owner'],
      reason: 'Duplicate',
    },
    { email: 'admin@example.com', roles: ['owner'], reason: 'ok' },
    {
      email: 'admin@example.com',
      roles: ['owner'],
      reason: 'Approved owner',
      tenantId: crypto.randomUUID(),
    },
  ])
    expect(administratorInvitationSchema.safeParse(input).success).toBe(false);
});
it('normalizes only approved company provisioning fields', () => {
  expect(
    companyProvisioningSchema.parse({
      companyName: ' Example Company ',
      employeeLimit: 20,
      billingMode: 'complimentary',
      initialOwnerEmail: ' Owner@Example.COM ',
    }),
  ).toEqual({
    companyName: 'Example Company',
    employeeLimit: 20,
    billingMode: 'complimentary',
    initialOwnerEmail: 'owner@example.com',
  });
  for (const input of [
    {
      companyName: 'Company',
      employeeLimit: 251,
      billingMode: 'free',
      initialOwnerEmail: 'owner@example.com',
    },
    {
      companyName: 'Company',
      employeeLimit: 10,
      billingMode: 'complimentary',
      initialOwnerEmail: 'owner@example.com',
    },
    {
      companyName: 'Company',
      employeeLimit: 20,
      billingMode: 'free',
      initialOwnerEmail: 'owner@example.com',
    },
    {
      companyName: 'Company',
      employeeLimit: 5,
      billingMode: 'free',
      initialOwnerEmail: 'owner@example.com',
      roles: ['platform_operator'],
    },
    {
      companyName: 'Company',
      employeeLimit: 5,
      billingMode: 'unlimited',
      initialOwnerEmail: 'owner@example.com',
    },
  ])
    expect(companyProvisioningSchema.safeParse(input).success).toBe(false);
});
it('accepts only the safe entitlement projection', () => {
  const value = {
    plan: { code: 'business', version: 1 },
    billingMode: 'complimentary',
    employeeLimit: 100,
    activeEmployees: 32,
    availableEmployeeSeats: 68,
    capabilities: { companySetup: true },
    entitlementVersion: 1,
    effectiveFrom: '2026-09-08T00:00:00.000Z',
  };
  expect(entitlementSnapshotSchema.parse(value)).toEqual(value);
  expect(
    entitlementSnapshotSchema.safeParse({
      ...value,
      capabilities: { companySetup: true, payroll: true },
    }).success,
  ).toBe(false);
});
it('accepts only bounded dated entitlement changes and explicit revocations', () => {
  const interval = {
    startsAt: '2026-09-08T00:00:00.000Z',
    endsAt: '2026-10-08T00:00:00.000Z',
    reason: 'Approved temporary capacity',
  };
  expect(
    entitlementChangeSchema.parse({
      changeType: 'capacity_addon',
      seatDelta: 10,
      ...interval,
    }),
  ).toMatchObject({ seatDelta: 10 });
  for (const input of [
    { changeType: 'capacity_addon', seatDelta: 0, ...interval },
    {
      changeType: 'complimentary',
      employeeLimit: 10,
      ...interval,
    },
    {
      changeType: 'employee_limit_override',
      employeeLimit: 5,
      seatDelta: 2,
      ...interval,
    },
    {
      changeType: 'capacity_addon',
      seatDelta: 2,
      ...interval,
      endsAt: interval.startsAt,
    },
  ])
    expect(entitlementChangeSchema.safeParse(input).success).toBe(false);
  expect(
    entitlementRevocationSchema.safeParse({
      expectedVersion: 1,
      reason: 'Approval withdrawn',
    }).success,
  ).toBe(true);
  expect(
    entitlementRevocationSchema.safeParse({
      expectedVersion: 0,
      reason: 'Approval withdrawn',
      status: 'revoked',
    }).success,
  ).toBe(false);
});
it('accepts only a normalized email for employee account requests', () => {
  expect(
    employeeAccountProvisioningSchema.parse({ email: ' Staff@Example.COM ' }),
  ).toEqual({ email: 'staff@example.com' });
  for (const input of [
    { email: 'invalid' },
    { email: 'staff@example.com', role: 'owner' },
    { email: 'staff@example.com', tenantId: crypto.randomUUID() },
  ])
    expect(employeeAccountProvisioningSchema.safeParse(input).success).toBe(
      false,
    );
});
it.each([
  { employeeNumber: '', name: 'Name' },
  { employeeNumber: '=CMD()', name: 'Name' },
  { employeeNumber: 'ok', name: ' ' },
  { employeeNumber: 'ok', name: 'A'.repeat(161) },
  { employeeNumber: 'ok', name: 'Name', tenantId: 'injected' },
  { employeeNumber: 'ok', name: 'Name', status: 'active' },
])('rejects invalid or mass-assigned employee fields', (input) => {
  expect(employeeDraftSchema.safeParse(input).success).toBe(false);
});
it('validates tenant IDs and health responses', () => {
  expect(tenantIdSchema.safeParse('not-a-uuid').success).toBe(false);
  expect(
    tenantSelectionSchema.safeParse({
      tenantId: crypto.randomUUID(),
      role: 'owner',
    }).success,
  ).toBe(false);
  expect(
    healthSchema.safeParse({ status: 'ok', service: 'kinto-api' }).success,
  ).toBe(true);
  expect(
    healthSchema.safeParse({
      status: 'ok',
      service: 'other',
      password: 'secret',
    }).success,
  ).toBe(false);
});
it('accepts only bounded security audit filters and opaque cursors', () => {
  expect(
    securityAuditQuerySchema.parse({
      limit: '25',
      action: 'membership.roles_changed',
      from: '2026-09-01T00:00:00+05:00',
      to: '2026-09-02T00:00:00+05:00',
      cursor: 'a'.repeat(48),
    }),
  ).toMatchObject({ limit: 25, action: 'membership.roles_changed' });
  for (const input of [
    { limit: '0' },
    { limit: '101' },
    { action: 'Membership changed' },
    { cursor: 'not-opaque' },
    { from: '2026-09-03T00:00:00Z', to: '2026-09-02T00:00:00Z' },
    { limit: '10', tenantId: crypto.randomUUID() },
  ])
    expect(securityAuditQuerySchema.safeParse(input).success).toBe(false);
});
it('validates Pakistan legal entity and branch setup without mass assignment', () => {
  expect(
    legalEntityCreateSchema.parse({
      legalName: ' Acme (Private) Limited ',
      registrationNumber: '0123456',
      taxNumber: '1234567-8',
      provinceCode: 'PK-PB',
      reason: 'Initial company setup',
    }),
  ).toMatchObject({ legalName: 'Acme (Private) Limited' });
  expect(
    branchCreateSchema.parse({
      code: ' lhr-01 ',
      name: ' Lahore Head Office ',
      provinceCode: 'PK-PB',
      reason: 'Initial branch setup',
    }),
  ).toMatchObject({ code: 'LHR-01', name: 'Lahore Head Office' });
  for (const input of [
    { legalName: 'Acme', provinceCode: 'Punjab', reason: 'Invalid province' },
    {
      legalName: 'Acme',
      provinceCode: 'PK-PB',
      reason: 'Initial setup',
      currencyCode: 'USD',
    },
  ])
    expect(legalEntityCreateSchema.safeParse(input).success).toBe(false);
  expect(
    legalEntityUpdateSchema.safeParse({
      expectedVersion: 0,
      legalName: 'Acme',
      provinceCode: 'PK-PB',
      reason: 'Invalid version',
    }).success,
  ).toBe(false);
  expect(
    branchUpdateSchema.safeParse({
      expectedVersion: 1,
      code: '=CMD()',
      name: 'Branch',
      provinceCode: 'PK-PB',
      status: 'active',
      reason: 'Invalid branch code',
    }).success,
  ).toBe(false);
});
it('normalizes bounded organization catalogs without accepting lifecycle fields on create', () => {
  expect(
    organizationCatalogCreateSchema.parse({
      code: ' eng ',
      name: ' Engineering ',
      reason: 'Initial department setup',
    }),
  ).toEqual({
    code: 'ENG',
    name: 'Engineering',
    reason: 'Initial department setup',
  });
  expect(
    organizationCatalogUpdateSchema.safeParse({
      expectedVersion: 1,
      code: 'SWE',
      name: 'Software Engineer',
      status: 'inactive',
      reason: 'Retire duplicate title',
    }).success,
  ).toBe(true);
  for (const input of [
    { code: '=BAD', name: 'Bad', reason: 'Invalid code' },
    {
      code: 'ENG',
      name: 'Engineering',
      status: 'active',
      reason: 'Mass assigned status',
    },
  ])
    expect(organizationCatalogCreateSchema.safeParse(input).success).toBe(
      false,
    );
});
it('accepts only typed organization-default policy drafts and publication', () => {
  const branchId = crypto.randomUUID();
  expect(
    organizationPolicyDraftSchema.parse({
      expectedCurrentVersion: 0,
      effectiveFrom: '2026-09-06',
      settings: { defaultBranchId: branchId },
      reason: 'Select the initial default branch',
    }),
  ).toMatchObject({ settings: { defaultBranchId: branchId } });
  for (const input of [
    {
      expectedCurrentVersion: 0,
      effectiveFrom: '06-09-2026',
      settings: { defaultBranchId: branchId },
      reason: 'Invalid date',
    },
    {
      expectedCurrentVersion: 0,
      effectiveFrom: '2026-09-06',
      settings: { defaultBranchId: branchId, absenceRule: 'deduct' },
      reason: 'Unsupported setting',
    },
  ])
    expect(organizationPolicyDraftSchema.safeParse(input).success).toBe(false);
  expect(
    organizationPolicyPublishSchema.safeParse({
      expectedVersion: 1,
      reason: 'Publish approved defaults',
    }).success,
  ).toBe(true);
});
it('requires explicit authenticated identity claims without accepting supplied roles', () => {
  const principal = {
    issuer: 'https://identity.example/realm',
    subject: 'case-sensitive-Subject',
    mfaVerified: false,
  };
  expect(authenticatedIdentitySchema.parse(principal)).toEqual(principal);
  expect(
    authenticatedIdentitySchema.safeParse({ ...principal, roles: ['owner'] })
      .success,
  ).toBe(false);
  expect(
    authenticatedIdentitySchema.safeParse({ ...principal, subject: '' })
      .success,
  ).toBe(false);
  expect(
    authenticatedIdentitySchema.safeParse({ ...principal, mfaVerified: 'true' })
      .success,
  ).toBe(false);
  expect(tenantRoleSchema.safeParse('platform_operator').success).toBe(false);
});
it('accepts only canonical administrative membership mutations', () => {
  expect(
    membershipRoleUpdateSchema.parse({
      expectedVersion: 2,
      roles: ['payroll_approver', 'owner'],
      reason: 'Owner approved access change',
    }),
  ).toEqual({
    expectedVersion: 2,
    roles: ['owner', 'payroll_approver'],
    reason: 'Owner approved access change',
  });
  for (const input of [
    { expectedVersion: 1, roles: ['employee'], reason: 'Invalid role' },
    {
      expectedVersion: 1,
      roles: ['owner', 'owner'],
      reason: 'Duplicate role',
    },
    { expectedVersion: 1, roles: ['owner'], reason: 'ok' },
    {
      expectedVersion: 1,
      roles: ['owner'],
      reason: 'Valid reason',
      tenantId: crypto.randomUUID(),
    },
  ])
    expect(membershipRoleUpdateSchema.safeParse(input).success).toBe(false);
  expect(
    membershipRevocationSchema.safeParse({
      expectedVersion: 1,
      reason: 'Access is no longer required',
    }).success,
  ).toBe(true);
  expect(
    membershipRevocationSchema.safeParse({
      expectedVersion: 1,
      reason: 'Valid reason',
      status: 'revoked',
    }).success,
  ).toBe(false);
});

it('normalizes complete monthly-salaried employee records and reporting rules', () => {
  const branchId = crypto.randomUUID();
  const departmentId = crypto.randomUUID();
  const designationId = crypto.randomUUID();
  expect(
    employeeRecordCreateSchema.parse({
      employeeNumber: ' emp-001 ',
      name: ' Sana Khan ',
      joiningDate: '2026-09-08',
      employmentType: 'monthly_salaried',
      branchId,
      departmentId,
      designationId,
      managerEmployeeId: null,
      topLevelReason: 'Company chief executive',
      reason: 'Create initial employee record',
    }),
  ).toMatchObject({ employeeNumber: 'EMP-001', name: 'Sana Khan' });
  const common = {
    branchId,
    departmentId,
    designationId,
    reason: 'Approved organization assignment',
  };
  expect(
    employeeRecordCreateSchema.safeParse({
      ...common,
      employeeNumber: 'EMP-002',
      name: 'Worker',
      joiningDate: '2026-09-08',
      employmentType: 'hourly',
      managerEmployeeId: null,
      topLevelReason: 'Top level role',
    }).success,
  ).toBe(false);
  expect(
    employeeAssignmentCreateSchema.safeParse({
      ...common,
      expectedVersion: 1,
      effectiveFrom: '2026-10-01',
      managerEmployeeId: null,
    }).success,
  ).toBe(false);
  expect(
    employeeAssignmentCreateSchema.safeParse({
      ...common,
      expectedVersion: 1,
      effectiveFrom: '2026-10-01',
      managerEmployeeId: crypto.randomUUID(),
      topLevelReason: 'Conflicting exception',
    }).success,
  ).toBe(false);
  expect(
    employeeProfileUpdateSchema.safeParse({
      expectedVersion: 1,
      name: 'Sana Khan',
      reason: 'Correct public profile',
      salary: 100000,
    }).success,
  ).toBe(false);
  expect(
    employeeActivationSchema.parse({
      expectedVersion: 3,
      reason: 'Approved employee activation',
    }),
  ).toEqual({ expectedVersion: 3, reason: 'Approved employee activation' });
  expect(
    employeeActivationSchema.safeParse({
      expectedVersion: 3,
      reason: 'Approved employee activation',
      status: 'active',
    }).success,
  ).toBe(false);
  expect(
    employeeTerminationSchema.parse({
      expectedVersion: 4,
      finalWorkingDate: '2026-09-30',
      reason: 'Approved end of employment',
    }),
  ).toEqual({
    expectedVersion: 4,
    finalWorkingDate: '2026-09-30',
    reason: 'Approved end of employment',
  });
  expect(
    employeeTerminationSchema.safeParse({
      expectedVersion: 4,
      finalWorkingDate: '09/30/2026',
      reason: 'Approved end of employment',
    }).success,
  ).toBe(false);
  expect(
    employeeArchiveSchema.parse({
      expectedVersion: 5,
      reason: 'Retention archive approved',
    }),
  ).toEqual({ expectedVersion: 5, reason: 'Retention archive approved' });
  expect(
    employeeArchiveSchema.safeParse({
      expectedVersion: 5,
      reason: 'Retention archive approved',
      deleteHistory: true,
    }).success,
  ).toBe(false);
  expect(
    employeeRehireSchema.parse({
      expectedVersion: 5,
      joiningDate: '2026-10-01',
      branchId,
      departmentId,
      designationId,
      managerEmployeeId: null,
      topLevelReason: 'Approved top-level role',
      reason: 'Approved employee rehire',
    }),
  ).toMatchObject({ joiningDate: '2026-10-01' });
  expect(
    employeeRehireSchema.safeParse({
      expectedVersion: 5,
      joiningDate: '2026-10-01',
      branchId,
      departmentId,
      designationId,
      managerEmployeeId: null,
      reason: 'Approved employee rehire',
      restoreAccess: true,
    }).success,
  ).toBe(false);
});
