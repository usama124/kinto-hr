import {
  attendanceTimingSettingsSchema,
  attendanceTimingPolicyDraftSchema,
} from './attendance-timing';
import {
  syntheticInboxReviewQuerySchema,
  syntheticInboxPreviewQuerySchema,
  syntheticInboxEventSchema,
  syntheticInboxMappingPreviewSchema,
} from './synthetic-inbox-review';
import {
  deviceMappingCreateSchema,
  deviceMappingEndSchema,
  deviceMappingResolveQuerySchema,
  deviceMappingResolutionSchema,
  deviceMappingListSchema,
} from './device-mappings';
import {
  connectorRedemptionRequestSchema,
  connectorHeartbeatRequestSchema,
  connectorHeartbeatResultSchema,
  connectorCredentialSchema,
  connectorRecordSchema,
  connectorRedemptionResultSchema,
  enrollmentIssueSchema,
  enrollmentRevokeSchema,
  enrollmentItemSchema,
  enrollmentIssueResultSchema,
  enrollmentListQuerySchema,
  enrollmentListSchema,
} from './enrollment';
import {
  attendanceAllocationSchema,
  attendanceAllocationSnapshotSchema,
  attendanceAllocationResultSchema,
} from './attendance-entitlements';
import {
  deviceCreateSchema,
  deviceUpdateSchema,
  deviceListQuerySchema,
  deviceInventorySchema,
} from './devices';
import { describe, expect, it } from 'vitest';
import {
  attendanceSourceEventSchema,
  attendanceBatchEnvelopeSchema,
  attendanceBatchReceiptSchema,
} from './attendance';
import {
  authenticatedIdentitySchema,
  tenantRoleSchema,
  employeeDraftSchema,
  healthSchema,
  tenantIdSchema,
  tenantSelectionSchema,
  companyProvisioningSchema,
  companyProvisioningResultSchema,
  platformAccessSchema,
  platformEntitlementStateSchema,
  platformCompanyQuerySchema,
  platformCompanyListSchema,
  entitlementSnapshotSchema,
  employeeAccountProvisioningSchema,
  employeeAccountProvisioningResultSchema,
  employeeAccountReactivationSchema,
  employeeAccountReactivationResultSchema,
  membershipRoleUpdateSchema,
  membershipRevocationSchema,
  membershipAdministrationListSchema,
  membershipAdministrationResultSchema,
  administratorInvitationSchema,
  administratorInvitationResultSchema,
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
  employeeBankDetailsUpdateSchema,
  employeeBankDetailsResponseSchema,
  employeePrivateDetailsUpdateSchema,
  employeeCompensationRevisionSchema,
  employeeChecklistTaskCreateSchema,
  employeeChecklistTaskCompletionSchema,
  employeeImportUploadSchema,
  employeeImportConfirmationSchema,
  employeeDocumentRegistrationSchema,
  parseEmployeeImportCsv,
  employeeAssignmentCreateSchema,
  workforceHeadcountQuerySchema,
  workforceHeadcountReportSchema,
  workforceReportExportCreateSchema,
  workforceReportExportViewSchema,
} from './index';
it('accepts strict workforce export creation and status projections', () => {
  const parameters = {
    asOf: '2026-09-25',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  };
  expect(
    workforceReportExportCreateSchema.parse({
      kind: 'workforce_headcount_csv',
      parameters,
      reason: 'Monthly workforce review',
    }),
  ).toEqual({
    kind: 'workforce_headcount_csv',
    parameters,
    reason: 'Monthly workforce review',
  });
  expect(
    workforceReportExportCreateSchema.safeParse({
      kind: 'employee_private_csv',
      parameters,
      reason: 'Unsupported private export',
    }).success,
  ).toBe(false);
  expect(
    workforceReportExportViewSchema.safeParse({
      id: crypto.randomUUID(),
      kind: 'workforce_headcount_csv',
      status: 'ready',
      parameters,
      createdAt: '2026-09-25T10:00:00.000Z',
      expiresAt: '2026-09-26T10:00:00.000Z',
      report: { employeeNames: ['Private'] },
    }).success,
  ).toBe(false);
});

it('allowlists synthetic attendance rows and preserves local timestamps and leading zeros', () => {
  const row = {
    connectorEventId: '00000000-0000-4000-8000-000000000001',
    sourceUserId: '00007',
    sourceLocalTimestamp: '2026-10-04T09:00:00.123',
  };
  expect(attendanceSourceEventSchema.parse(row)).toEqual(row);
  for (const change of [
    { sourceLocalTimestamp: '2026-02-30T09:00:00' },
    { sourceLocalTimestamp: '2026-10-04T09:00:00Z' },
    { sourceLocalTimestamp: '2026-10-04T09:00:00+05:00' },
    { sourceLocalTimestamp: '2026-10-04T09:00' },
    { sourceLocalTimestamp: '2026-10-04T09:00:00.1234' },
    { sourceUserId: 7 },
    { sourceUserId: ' 7 ' },
    { direction: 'unknown' },
    { workCode: 'bad code' },
    { sourceEventId: '' },
    { fingerprint: 'private' },
    { photo: 'private' },
    { cnic: 'private' },
    { tenantId: 'caller' },
  ])
    expect(
      attendanceSourceEventSchema.safeParse({ ...row, ...change }).success,
    ).toBe(false);
  const batch = {
    batchId: row.connectorEventId,
    deviceId: row.connectorEventId,
    schemaVersion: 1,
    adapterVersion: 'synthetic-1',
    events: [null, row],
  };
  expect(attendanceBatchEnvelopeSchema.parse(batch)).toEqual(batch);
  for (const change of [
    { events: [] },
    { events: Array(501).fill(row) },
    { schemaVersion: 2 },
    { adapterVersion: ' invalid' },
    { timezone: 'Asia/Karachi' },
  ])
    expect(
      attendanceBatchEnvelopeSchema.safeParse({ ...batch, ...change }).success,
    ).toBe(false);
});

it('requires ordered strict per-record attendance receipts without treating schemas as durable acknowledgments', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const receipt = {
    receiptId: id,
    batchId: id,
    deviceId: id,
    schemaVersion: 1,
    events: [
      { index: 0, connectorEventId: id, disposition: 'stored' },
      { index: 1, connectorEventId: id, disposition: 'duplicate' },
      {
        index: 2,
        connectorEventId: id,
        disposition: 'quarantined',
        code: 'source_identity_unverified',
      },
      { index: 3, disposition: 'rejected_unstored', code: 'invalid_event' },
    ],
  };
  expect(attendanceBatchReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const events of [
    [],
    [...receipt.events].reverse(),
    receipt.events.map((row) => ({ ...row, index: 0 })),
    [{ index: 0, disposition: 'stored' }],
    [
      {
        index: 0,
        connectorEventId: id,
        disposition: 'quarantined',
        code: 'arbitrary',
      },
    ],
    [
      {
        index: 0,
        disposition: 'rejected_unstored',
        code: 'invalid_event',
        raw: 'secret',
      },
    ],
  ])
    expect(
      attendanceBatchReceiptSchema.safeParse({ ...receipt, events }).success,
    ).toBe(false);
});

it('accepts only strict employee account reactivation commands and results', () => {
  expect(
    employeeAccountReactivationSchema.parse({
      expectedMembershipVersion: 2,
      reason: 'Approved access restoration after rehire',
    }),
  ).toEqual({
    expectedMembershipVersion: 2,
    reason: 'Approved access restoration after rehire',
  });
  expect(
    employeeAccountReactivationSchema.safeParse({
      expectedMembershipVersion: 2,
      reason: 'Approved access restoration after rehire',
      email: 'replacement@example.com',
    }).success,
  ).toBe(false);
  expect(
    employeeAccountReactivationResultSchema.parse({
      membershipId: crypto.randomUUID(),
      membershipVersion: 3,
      status: 'active',
    }).status,
  ).toBe('active');
});

it('accepts bounded workforce report dates and strict aggregate results', () => {
  const query = {
    asOf: '2026-09-25',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
  };
  expect(workforceHeadcountQuerySchema.parse(query)).toEqual(query);
  expect(
    workforceHeadcountQuerySchema.safeParse({
      ...query,
      periodStart: '2026-10-01',
    }).success,
  ).toBe(false);
  expect(
    workforceHeadcountQuerySchema.safeParse({
      ...query,
      periodEnd: '2028-01-01',
    }).success,
  ).toBe(false);
  expect(
    workforceHeadcountReportSchema.safeParse({
      ...query,
      headcount: 2,
      joiners: 1,
      leavers: 1,
      departments: [],
      unassignedHeadcount: 0,
      employeeNames: ['Private value'],
    }).success,
  ).toBe(false);
});

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
  const result = {
    accountRequestId: crypto.randomUUID(),
    status: 'pending_identity_provider',
    replayed: false,
  };
  expect(administratorInvitationResultSchema.parse(result)).toEqual(result);
  expect(
    administratorInvitationResultSchema.parse({
      ...result,
      status: 'pending_delivery',
    }).status,
  ).toBe('pending_delivery');
  for (const change of [
    { accountRequestId: 'invalid' },
    { status: 'delivered' },
    { replayed: 'yes' },
    { email: 'private@example.com' },
  ])
    expect(
      administratorInvitationResultSchema.safeParse({ ...result, ...change })
        .success,
    ).toBe(false);
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
  expect(platformCompanyQuerySchema.parse({ search: ' Test ' })).toEqual({
    limit: 25,
    search: 'Test',
  });
  for (const query of [
    { limit: 0 },
    { limit: 101 },
    { after: 'invalid' },
    { search: '' },
    { email: 'private@example.com' },
  ])
    expect(platformCompanyQuerySchema.safeParse(query).success).toBe(false);
  const company = {
    id: crypto.randomUUID(),
    name: 'Synthetic',
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
    ownerSetupStatus: null,
    baseSubscription: null,
  };
  expect(
    platformCompanyListSchema.parse({ companies: [company], nextCursor: null }),
  ).toEqual({ companies: [company], nextCursor: null });
  for (const change of [
    { email: 'private@example.com' },
    { status: 'unknown' },
    { baseSubscription: { plan: 'fake' } },
  ])
    expect(
      platformCompanyListSchema.safeParse({
        companies: [{ ...company, ...change }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  const result = {
    tenantId: crypto.randomUUID(),
    provisioningRequestId: crypto.randomUUID(),
    status: 'pending_identity_provider',
    replayed: false,
  };
  expect(companyProvisioningResultSchema.parse(result)).toEqual(result);
  for (const change of [
    { tenantId: 'invalid' },
    { status: 'unknown' },
    { initialOwnerEmail: 'private@example.com' },
    { replayed: 'yes' },
  ])
    expect(
      companyProvisioningResultSchema.safeParse({ ...result, ...change })
        .success,
    ).toBe(false);
  expect(platformAccessSchema.parse({ canProvisionCompany: true })).toEqual({
    canProvisionCompany: true,
  });
  expect(
    platformAccessSchema.safeParse({ canProvisionCompany: false }).success,
  ).toBe(false);
  expect(
    platformAccessSchema.safeParse({
      canProvisionCompany: true,
      roles: ['owner'],
    }).success,
  ).toBe(false);
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
  const result = {
    id: crypto.randomUUID(),
    status: 'active',
    roles: ['owner'],
    version: 1,
  };
  const member = {
    ...result,
    identityId: crypto.randomUUID(),
    employeeId: null,
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  expect(membershipAdministrationResultSchema.parse(result)).toEqual(result);
  expect(
    membershipAdministrationListSchema.parse({ memberships: [member] }),
  ).toEqual({ memberships: [member] });
  for (const change of [
    { status: 'pending' },
    { roles: ['platform_operator'] },
    { roles: ['owner', 'owner'] },
    { version: 0 },
    { employeeId: 'invalid' },
    { createdAt: 'invalid' },
    { email: 'private@example.com' },
  ])
    expect(
      membershipAdministrationListSchema.safeParse({
        memberships: [{ ...member, ...change }],
      }).success,
    ).toBe(false);
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

it('parses only bounded operator entitlement state without actor fields', () => {
  const state = {
    tenantId: crypto.randomUUID(),
    companyName: 'Synthetic',
    evaluatedAt: '2026-10-01T09:00:00Z',
    historyTruncated: false,
    effective: {
      plan: { code: 'free', version: 1 },
      billingMode: 'free',
      employeeLimit: 5,
      activeEmployees: 0,
      availableEmployeeSeats: 5,
      capabilities: { companySetup: true },
      entitlementVersion: 1,
      effectiveFrom: '2026-10-01T09:00:00Z',
    },
    controls: [],
  };
  expect(platformEntitlementStateSchema.parse(state)).toEqual(state);
  expect(
    platformEntitlementStateSchema.safeParse({
      ...state,
      identityId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    platformEntitlementStateSchema.safeParse({ ...state, tenantId: 'invalid' })
      .success,
  ).toBe(false);
  expect(
    platformEntitlementStateSchema.safeParse({
      ...state,
      controls: [{ status: 'unknown' }],
    }).success,
  ).toBe(false);
});

it('validates employee setup receipts without exposing provider identities or accepting unknown statuses', () => {
  const result = {
    accountRequestId: '9d2ea3ef-3938-42d0-84f9-d2248f692f67',
    status: 'pending_activation',
    replayed: true,
  };
  expect(employeeAccountProvisioningResultSchema.parse(result)).toEqual(result);
  for (const invalid of [
    { ...result, identityId: result.accountRequestId },
    { ...result, status: 'accepted' },
    { ...result, accountRequestId: 'wrong' },
    { ...result, replayed: 'true' },
  ]) {
    expect(
      employeeAccountProvisioningResultSchema.safeParse(invalid).success,
    ).toBe(false);
  }
});

it('normalizes optional bank details while rejecting partial, unsafe and unversioned clears', () => {
  const input = {
    expectedVersion: 0,
    bankName: ' Synthetic Bank ',
    accountTitle: ' Synthetic Account ',
    accountNumber: ' 00 ab 1234 ',
    reason: 'initial_setup',
  };
  expect(employeeBankDetailsUpdateSchema.parse(input)).toEqual({
    ...input,
    bankName: 'Synthetic Bank',
    accountTitle: 'Synthetic Account',
    accountNumber: '00AB1234',
  });
  for (const change of [
    { accountTitle: null },
    { accountNumber: '00-1234' },
    { accountNumber: 'A'.repeat(35) },
    { bankName: '' },
    { bankName: 'B'.repeat(121) },
    { accountTitle: 'T'.repeat(161) },
    { reason: 'Arbitrary sensitive private reason' },
    { reason: 'clear_details' },
    { expectedVersion: 2147483647 },
    { password: 'private' },
  ])
    expect(
      employeeBankDetailsUpdateSchema.safeParse({ ...input, ...change })
        .success,
    ).toBe(false);
  const cleared = {
    expectedVersion: 1,
    bankName: null,
    accountTitle: null,
    accountNumber: null,
    reason: 'clear_details',
  };
  expect(employeeBankDetailsUpdateSchema.parse(cleared)).toEqual(cleared);
  expect(
    employeeBankDetailsUpdateSchema.safeParse({
      ...cleared,
      expectedVersion: 0,
    }).success,
  ).toBe(false);
  expect(
    employeeBankDetailsUpdateSchema.safeParse({
      ...cleared,
      reason: 'account_change',
    }).success,
  ).toBe(false);
  expect(employeeBankDetailsResponseSchema.parse({ details: null })).toEqual({
    details: null,
  });
});

it('restricts device inventory to credential-free draft metadata and reviewed transitions', () => {
  const branchId = '00000000-0000-4000-8000-000000000001';
  const create = {
    branchId,
    code: 'K50-01',
    name: ' Entrance ',
    model: 'ZKTeco_K50',
    firmware: null,
    sourceTimezone: 'Asia/Karachi',
    reason: 'initial_setup',
  };
  expect(deviceCreateSchema.parse(create).name).toBe('Entrance');
  for (const change of [
    { code: 'invalid code' },
    { firmware: 'private\nvalue' },
    { model: 'Unknown' },
    { sourceTimezone: 'UTC' },
    { password: 'secret' },
    { tenantId: branchId },
    { sourceIdentityStatus: 'verified' },
  ])
    expect(deviceCreateSchema.safeParse({ ...create, ...change }).success).toBe(
      false,
    );
  const update = {
    branchId,
    name: 'Entrance',
    model: 'ZKTeco_K50',
    firmware: 'synthetic-1',
    sourceTimezone: 'Asia/Karachi',
    expectedVersion: 1,
    status: 'draft',
    reason: 'metadata_correction',
  };
  expect(deviceUpdateSchema.parse(update)).toEqual(update);
  expect(
    deviceUpdateSchema.safeParse({
      ...update,
      status: 'retired',
      reason: 'retire_device',
    }).success,
  ).toBe(true);
  for (const change of [
    { expectedVersion: 0 },
    { expectedVersion: 2147483647 },
    { status: 'active' },
    { status: 'retired' },
    { reason: 'retire_device' },
    { code: 'NEW' },
  ])
    expect(deviceUpdateSchema.safeParse({ ...update, ...change }).success).toBe(
      false,
    );
  expect(deviceListQuerySchema.parse({})).toEqual({ limit: 25 });
  expect(
    deviceListQuerySchema.parse({ limit: '50', afterId: branchId }),
  ).toEqual({ limit: 50, afterId: branchId });
  for (const value of [
    { limit: 0 },
    { limit: 51 },
    { limit: 'bad' },
    { limit: 1.5 },
    { tenantId: branchId },
  ])
    expect(deviceListQuerySchema.safeParse(value).success).toBe(false);
  expect(deviceInventorySchema.parse({ items: [], nextCursor: null })).toEqual({
    items: [],
    nextCursor: null,
  });
});

it('validates explicit attendance allocations without granting machine access or paid-plan defaults', () => {
  const initial = {
    expectedVersion: 0,
    enabled: true,
    deviceLimit: 2,
    connectorLimit: 1,
    reason: 'initial_setup',
  };
  expect(attendanceAllocationSchema.parse(initial)).toEqual(initial);
  expect(
    attendanceAllocationSchema.safeParse({
      ...initial,
      expectedVersion: 1,
      reason: 'allocation_change',
    }).success,
  ).toBe(true);
  expect(
    attendanceAllocationSchema.safeParse({
      expectedVersion: 1,
      enabled: false,
      deviceLimit: 0,
      connectorLimit: 0,
      reason: 'disable_attendance',
    }).success,
  ).toBe(true);
  for (const change of [
    { deviceLimit: 0 },
    { connectorLimit: 0 },
    { deviceLimit: 1001 },
    { connectorLimit: -1 },
    { deviceLimit: 1.5 },
    { enabled: false },
    { expectedVersion: 1 },
    { reason: 'free text' },
    { actorId: 'caller' },
    { machineAccessAvailable: true },
  ])
    expect(
      attendanceAllocationSchema.safeParse({ ...initial, ...change }).success,
    ).toBe(false);
  const base = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    version: 0,
    enabled: false,
    deviceLimit: 0,
    connectorLimit: 0,
    configuredAt: null,
    machineAccessAvailable: false,
  };
  expect(attendanceAllocationSnapshotSchema.parse(base)).toEqual(base);
  expect(
    attendanceAllocationSnapshotSchema.safeParse({
      ...base,
      version: 1,
      enabled: true,
      deviceLimit: 2,
      connectorLimit: 1,
      configuredAt: '2026-10-04T00:00:00Z',
    }).success,
  ).toBe(true);
  for (const change of [
    { deviceLimit: 1 },
    { enabled: true },
    { configuredAt: '2026-10-04T00:00:00Z' },
    { version: 1 },
    { machineAccessAvailable: true },
  ])
    expect(
      attendanceAllocationSnapshotSchema.safeParse({ ...base, ...change })
        .success,
    ).toBe(false);
  expect(
    attendanceAllocationResultSchema.parse({
      id: base.tenantId,
      version: 1,
      replayed: true,
    }),
  ).toEqual({ id: base.tenantId, version: 1, replayed: true });
});

it('validates enrollment reservations and never accepts replayed or projected secrets', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    deviceId: id,
    expectedDeviceVersion: 1,
    expectedAllocationVersion: 1,
  };
  expect(enrollmentIssueSchema.parse(input)).toEqual(input);
  for (const change of [
    { deviceId: 'bad' },
    { expectedDeviceVersion: 0 },
    { expectedAllocationVersion: 0 },
    { tenantId: id },
    { token: 'secret' },
  ])
    expect(
      enrollmentIssueSchema.safeParse({ ...input, ...change }).success,
    ).toBe(false);
  expect(enrollmentRevokeSchema.parse({ expectedVersion: 1 })).toEqual({
    expectedVersion: 1,
  });
  expect(enrollmentRevokeSchema.safeParse({ expectedVersion: 2 }).success).toBe(
    false,
  );
  const item = {
    id,
    deviceId: id,
    expectedDeviceVersion: 1,
    allocationVersion: 1,
    version: 1,
    status: 'issued',
    createdAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-10-04T00:15:00Z',
    revokedAt: null,
  };
  expect(enrollmentItemSchema.parse(item)).toEqual(item);
  expect(
    enrollmentItemSchema.parse({ ...item, status: 'expired' }).status,
  ).toBe('expired');
  expect(
    enrollmentItemSchema.parse({
      ...item,
      status: 'revoked',
      version: 2,
      revokedAt: '2026-10-04T00:01:00Z',
    }).version,
  ).toBe(2);
  for (const change of [
    { expiresAt: '2026-10-04T00:16:00Z' },
    { status: 'revoked' },
    { version: 2 },
    { revokedAt: '2026-10-04T00:01:00Z' },
    { status: 'redeemed' },
    { tokenDigest: 'a'.repeat(64) },
  ])
    expect(enrollmentItemSchema.safeParse({ ...item, ...change }).success).toBe(
      false,
    );
  const result = {
    enrollment: item,
    replayed: false,
    token: 'ke1_' + 'a'.repeat(43),
    machineAccessAvailable: false,
  };
  expect(enrollmentIssueResultSchema.parse(result)).toEqual(result);
  expect(
    enrollmentIssueResultSchema.parse({
      ...result,
      replayed: true,
      token: null,
    }).token,
  ).toBeNull();
  for (const change of [
    { replayed: true },
    { token: null },
    { token: 'bad' },
    { machineAccessAvailable: true },
    { enrollment: { ...item, status: 'expired' } },
  ])
    expect(
      enrollmentIssueResultSchema.safeParse({ ...result, ...change }).success,
    ).toBe(false);
  expect(enrollmentListQuerySchema.parse({})).toEqual({ limit: 25 });
  expect(enrollmentListQuerySchema.parse({ limit: '1', afterId: id })).toEqual({
    limit: 1,
    afterId: id,
  });
  expect(enrollmentListQuerySchema.safeParse({ limit: 51 }).success).toBe(
    false,
  );
  expect(
    enrollmentListSchema.parse({
      items: [item],
      nextCursor: null,
      machineAccessAvailable: false,
    }).items,
  ).toHaveLength(1);
});

it('validates redeemed enrollment and bounded secret-free connector projections', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const connector = {
    id,
    tenantId: id,
    deviceId: id,
    enrollmentId: id,
    version: 1,
    status: 'active',
    createdAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-11-03T00:00:00Z',
    revokedAt: null,
    scope: 'heartbeat_only',
    attendanceIngestionAvailable: false,
  };
  expect(connectorRecordSchema.parse(connector)).toEqual(connector);
  expect(
    connectorRecordSchema.parse({ ...connector, status: 'expired' }).status,
  ).toBe('expired');
  expect(
    connectorRecordSchema.parse({
      ...connector,
      status: 'revoked',
      version: 2,
      revokedAt: '2026-10-04T01:00:00Z',
    }).version,
  ).toBe(2);
  for (const change of [
    { version: 2 },
    { status: 'revoked' },
    { expiresAt: '2026-11-04T00:00:00Z' },
    { credential: 'secret' },
    { credentialDigest: 'a'.repeat(64) },
    { scope: 'attendance' },
    { attendanceIngestionAvailable: true },
  ])
    expect(
      connectorRecordSchema.safeParse({ ...connector, ...change }).success,
    ).toBe(false);
  const credential = 'kc1_' + 'a'.repeat(43);
  expect(
    connectorRedemptionResultSchema.parse({ connector, credential }).credential,
  ).toBe(credential);
  expect(
    connectorCredentialSchema.safeParse('ke1_' + 'a'.repeat(43)).success,
  ).toBe(false);
  const redeemed = {
    id,
    deviceId: id,
    expectedDeviceVersion: 1,
    allocationVersion: 1,
    version: 2,
    status: 'redeemed',
    createdAt: '2026-10-04T00:00:00Z',
    expiresAt: '2026-10-04T00:15:00Z',
    revokedAt: null,
    redeemedAt: '2026-10-04T00:01:00Z',
    connectorId: id,
  };
  expect(enrollmentItemSchema.parse(redeemed)).toEqual(redeemed);
  for (const change of [
    { redeemedAt: undefined },
    { connectorId: undefined },
    { version: 1 },
    { status: 'issued' },
    { revokedAt: '2026-10-04T00:02:00Z' },
  ])
    expect(
      enrollmentItemSchema.safeParse({ ...redeemed, ...change }).success,
    ).toBe(false);
});

it('rejects caller-selected machine scope and heartbeat data', () => {
  expect(
    connectorRedemptionRequestSchema.parse({ token: 'ke1_' + 'a'.repeat(43) })
      .token,
  ).toMatch(/^ke1_/);
  expect(
    connectorRedemptionRequestSchema.safeParse({
      token: 'ke1_' + 'a'.repeat(43),
      tenantId: 'injected',
    }).success,
  ).toBe(false);
  expect(connectorHeartbeatRequestSchema.parse({})).toEqual({});
  expect(
    connectorHeartbeatRequestSchema.safeParse({ deviceId: 'injected' }).success,
  ).toBe(false);
  expect(
    connectorHeartbeatResultSchema.safeParse({ credential: 'secret' }).success,
  ).toBe(false);
});

it('keeps mapping source IDs exact and normalizes effective instants without weakening intervals', () => {
  const mapping = {
    employeeId: '00000000-0000-4000-8000-000000000001',
    sourceUserId: '0007',
    effectiveFrom: '2026-10-01T05:00:00+05:00',
    effectiveUntil: null,
    reason: 'initial_mapping',
  };
  expect(deviceMappingCreateSchema.parse(mapping)).toMatchObject({
    sourceUserId: '0007',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
  });
  for (const change of [
    { sourceUserId: 7 },
    { sourceUserId: ' 0007' },
    { sourceUserId: '' },
    { sourceUserId: 'a'.repeat(65) },
    { sourceUserId: 'name@example.com' },
    { effectiveUntil: '2026-10-01T00:00:00Z' },
    { effectiveUntil: '2026-09-01T00:00:00Z' },
    { effectiveFrom: '2026-10-01T00:00:00' },
    { effectiveFrom: '2026-10-01T00:00:00.0001Z' },
    { effectiveFrom: '2100-01-01T00:00:00Z' },
    { effectiveFrom: '1999-12-31T00:00:00Z' },
    { tenantId: mapping.employeeId },
    { password: 'secret' },
    { reason: 'caller' },
  ])
    expect(
      deviceMappingCreateSchema.safeParse({ ...mapping, ...change }).success,
    ).toBe(false);
  expect(
    deviceMappingCreateSchema.safeParse({
      ...mapping,
      effectiveUntil: '2026-10-02T00:00:00Z',
    }).success,
  ).toBe(true);
  const end = {
    expectedVersion: 1,
    effectiveUntil: '2026-10-02T00:00:00Z',
    reason: 'end_mapping',
  };
  expect(deviceMappingEndSchema.parse(end).effectiveUntil).toBe(
    '2026-10-02T00:00:00.000Z',
  );
  expect(
    deviceMappingEndSchema.safeParse({ ...end, employeeId: mapping.employeeId })
      .success,
  ).toBe(false);
  expect(
    deviceMappingEndSchema.safeParse({ ...end, expectedVersion: 0 }).success,
  ).toBe(false);
  expect(
    deviceMappingResolveQuerySchema.safeParse({
      sourceUserId: '0007',
      at: mapping.effectiveFrom,
    }).success,
  ).toBe(true);
});
it('does not guess an employee from unresolved mappings or enable processing through a list', () => {
  expect(
    deviceMappingResolutionSchema.parse({
      status: 'unmapped',
      mappingId: null,
      mappingVersion: null,
      employeeId: null,
    }).status,
  ).toBe('unmapped');
  expect(
    deviceMappingResolutionSchema.parse({
      status: 'ambiguous',
      mappingId: null,
      mappingVersion: null,
      employeeId: null,
    }).status,
  ).toBe('ambiguous');
  expect(
    deviceMappingResolutionSchema.safeParse({
      status: 'unmapped',
      mappingId: null,
      mappingVersion: null,
      employeeId: '00000000-0000-4000-8000-000000000001',
    }).success,
  ).toBe(false);
  const list = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    deviceId: '00000000-0000-4000-8000-000000000002',
    items: [],
    nextCursor: null,
    attendanceProcessingAvailable: false,
  };
  expect(deviceMappingListSchema.safeParse(list).success).toBe(true);
  expect(
    deviceMappingListSchema.safeParse({
      ...list,
      attendanceProcessingAvailable: true,
    }).success,
  ).toBe(false);
});

describe('synthetic inbox review contracts', () => {
  it('bounds pages and rejects caller-supplied mapping authority', () => {
    expect(syntheticInboxReviewQuerySchema.parse({})).toEqual({ limit: 25 });
    for (const input of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { sourceUserId: '0007' },
      { tenantId: 'injected' },
    ])
      expect(syntheticInboxReviewQuerySchema.safeParse(input).success).toBe(
        false,
      );
    expect(
      syntheticInboxPreviewQuerySchema.parse({
        at: '2026-10-01T05:00:00+05:00',
      }).at,
    ).toBe('2026-10-01T00:00:00.000Z');
    for (const input of [
      { at: '2026-10-01T09:00:00' },
      { at: '2100-01-01T00:00:00Z' },
      { at: '2026-10-01T00:00:00Z', sourceUserId: 'different' },
    ])
      expect(syntheticInboxPreviewQuerySchema.safeParse(input).success).toBe(
        false,
      );
  });
  it('keeps raw source values exact and excludes transport secrets or processing flags', () => {
    const raw = {
      id: '00000000-0000-4000-8000-000000000001',
      deviceId: '00000000-0000-4000-8000-000000000002',
      payload: {
        sourceUserId: '0007',
        sourceLocalTimestamp: '2026-10-07T09:00:00',
      },
      quarantineCode: 'source_identity_unverified',
      createdAt: '2026-10-07T00:00:00Z',
    };
    expect(syntheticInboxEventSchema.parse(raw).payload.sourceUserId).toBe(
      '0007',
    );
    expect(
      syntheticInboxEventSchema.safeParse({ ...raw, sourceKey: 'hidden' })
        .success,
    ).toBe(false);
    expect(
      syntheticInboxEventSchema.safeParse({
        ...raw,
        payload: { ...raw.payload, fingerprint: 'not-allowed' },
      }).success,
    ).toBe(false);
    const preview = {
      event: raw,
      requestedAt: '2026-10-01T00:00:00Z',
      timeBasis: 'operator_supplied_unverified',
      resolution: {
        status: 'unmapped',
        mappingId: null,
        mappingVersion: null,
        employeeId: null,
      },
      sourceIdentityVerified: false,
      clockVerified: false,
      attendanceProcessingAvailable: false,
    };
    expect(syntheticInboxMappingPreviewSchema.safeParse(preview).success).toBe(
      true,
    );
    for (const key of [
      'sourceIdentityVerified',
      'clockVerified',
      'attendanceProcessingAvailable',
    ])
      expect(
        syntheticInboxMappingPreviewSchema.safeParse({
          ...preview,
          [key]: true,
        }).success,
      ).toBe(false);
  });
});

// Employer-configured policy fixtures, not statutory recommendations.
const timingSettings = {
  scope: 'company',
  timeZone: 'Asia/Karachi',
  checkIn: '09:00',
  checkOut: '18:00',
  checkOutNextDay: false,
  breakMode: 'fixed_duration',
  unpaidBreakMinutes: 60,
  fullDayTargetMinutes: 480,
  halfDayTargetMinutes: 240,
  minimumFullDayMinutes: 420,
  minimumHalfDayMinutes: 180,
  lateGraceMinutes: 10,
  earlyGraceMinutes: 10,
  associationBeforeMinutes: 30,
  associationAfterMinutes: 30,
  weeklyRestDays: [7],
};
describe('company attendance timing contracts', () => {
  it('does not enable timing through the existing organization-defaults publication contract', () => {
    expect(
      organizationPolicyDraftSchema.safeParse({
        expectedCurrentVersion: 0,
        effectiveFrom: '2026-10-10',
        settings: timingSettings,
        reason: 'reviewed policy',
      }).success,
    ).toBe(false);
  });
  it('preserves separate targets/minimums and accepts explicit overnight settings', () => {
    expect(attendanceTimingSettingsSchema.parse(timingSettings)).toEqual(
      timingSettings,
    );
    expect(
      attendanceTimingSettingsSchema.parse({
        ...timingSettings,
        checkIn: '22:00',
        checkOut: '06:00',
        checkOutNextDay: true,
        unpaidBreakMinutes: 30,
        fullDayTargetMinutes: 450,
      }),
    ).toMatchObject({ fullDayTargetMinutes: 450, minimumFullDayMinutes: 420 });
  });
  it.each([
    { checkIn: '9:00' },
    { checkOut: '24:00' },
    { checkIn: '09:60' },
    { checkOut: '09:00' },
    { checkOut: '08:00' },
    { checkOutNextDay: true },
    { checkOut: '09:00', checkOutNextDay: true },
    { unpaidBreakMinutes: 540 },
    { unpaidBreakMinutes: 541 },
    { fullDayTargetMinutes: 481 },
    { fullDayTargetMinutes: 0 },
    { halfDayTargetMinutes: 480 },
    { halfDayTargetMinutes: 481 },
    { minimumFullDayMinutes: 481 },
    { minimumHalfDayMinutes: 420 },
    { minimumHalfDayMinutes: 241 },
    { minimumHalfDayMinutes: 0 },
    { lateGraceMinutes: 481 },
    { earlyGraceMinutes: 481 },
    { associationBeforeMinutes: 451, associationAfterMinutes: 450 },
    { weeklyRestDays: [7, 7] },
    { weeklyRestDays: [0] },
    { weeklyRestDays: [8] },
    { weeklyRestDays: [1, 2, 3, 4, 5, 6, 7] },
    { timeZone: 'UTC' },
    { scope: 'employee' },
    { branchId: 'override' },
    { breakMode: 'punches' },
    { checkIn: '09:00+05:00' },
  ])('rejects inconsistent/unsupported settings %j', (change) => {
    expect(
      attendanceTimingSettingsSchema.safeParse({ ...timingSettings, ...change })
        .success,
    ).toBe(false);
  });
  it.each([
    'unpaidBreakMinutes',
    'fullDayTargetMinutes',
    'halfDayTargetMinutes',
    'minimumFullDayMinutes',
    'minimumHalfDayMinutes',
    'lateGraceMinutes',
    'earlyGraceMinutes',
    'associationBeforeMinutes',
    'associationAfterMinutes',
  ])('rejects corrupt or coerced minute field %s', (field) => {
    for (const value of [-1, 0.5, 1440, NaN, Infinity, '60', null])
      expect(
        attendanceTimingSettingsSchema.safeParse({
          ...timingSettings,
          [field]: value,
        }).success,
      ).toBe(false);
  });
  it('allows exact threshold/net/window boundaries without manufacturing grace time', () => {
    const value = {
      ...timingSettings,
      minimumFullDayMinutes: 480,
      minimumHalfDayMinutes: 240,
      lateGraceMinutes: 480,
      earlyGraceMinutes: 480,
      associationBeforeMinutes: 450,
      associationAfterMinutes: 450,
      weeklyRestDays: [],
    };
    expect(attendanceTimingSettingsSchema.parse(value)).toEqual(value);
    expect(
      attendanceTimingSettingsSchema.parse({
        ...value,
        fullDayTargetMinutes: 450,
        minimumFullDayMinutes: 450,
      }),
    ).toMatchObject({ fullDayTargetMinutes: 450 });
  });
  it('requires explicit settings, version, effective date and reason without backdate guesses', () => {
    const draft = {
      expectedCurrentVersion: 0,
      effectiveFrom: '2026-10-10',
      settings: timingSettings,
      reason: ' Employer-reviewed schedule ',
    };
    expect(attendanceTimingPolicyDraftSchema.parse(draft).reason).toBe(
      'Employer-reviewed schedule',
    );
    for (const change of [
      { expectedCurrentVersion: -1 },
      { expectedCurrentVersion: 0.5 },
      { expectedCurrentVersion: '0' },
      { effectiveFrom: '2026-02-30' },
      { effectiveFrom: '2026-10-10T00:00:00Z' },
      { reason: '  ' },
      { employeeId: 'override' },
    ])
      expect(
        attendanceTimingPolicyDraftSchema.safeParse({ ...draft, ...change })
          .success,
      ).toBe(false);
    expect(attendanceTimingSettingsSchema.safeParse({}).success).toBe(false);
    // Future SQL publication will recheck effective-date/cutoff authority; the pure
    // contract intentionally does not substitute wall-clock checks for that gate.
    expect(
      attendanceTimingPolicyDraftSchema.parse({
        ...draft,
        effectiveFrom: '2020-01-01',
      }).effectiveFrom,
    ).toBe('2020-01-01');
  });
});
