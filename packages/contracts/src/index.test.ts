import { expect, it } from 'vitest';
import {
  authenticatedIdentitySchema,
  tenantRoleSchema,
  employeeDraftSchema,
  healthSchema,
  tenantIdSchema,
  tenantSelectionSchema,
  companyProvisioningSchema,
  employeeAccountProvisioningSchema,
  membershipRoleUpdateSchema,
  membershipRevocationSchema,
  administratorInvitationSchema,
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
