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
  employeeAssignmentCreateSchema,
} from './index';
it('trims names while preserving employee identifiers as strings', () => {
  expect(
    employeeDraftSchema.parse({ employeeNumber: '0012', name: ' Sana Khan ' }),
  ).toEqual({ employeeNumber: '0012', name: 'Sana Khan' });
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
});
