import { expect, it } from 'vitest';
import {
  authenticatedIdentitySchema,
  tenantRoleSchema,
  employeeDraftSchema,
  healthSchema,
  tenantIdSchema,
  companyProvisioningSchema,
} from './index';
it('trims names while preserving employee identifiers as strings', () => {
  expect(
    employeeDraftSchema.parse({ employeeNumber: '0012', name: ' Sana Khan ' }),
  ).toEqual({ employeeNumber: '0012', name: 'Sana Khan' });
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
