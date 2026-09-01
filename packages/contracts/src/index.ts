import { z } from 'zod';
export const tenantIdSchema = z.uuid();
export const employeeDraftSchema = z
  .object({
    employeeNumber: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().trim().min(1).max(160),
  })
  .strict();
export type EmployeeDraft = z.infer<typeof employeeDraftSchema>;
export const healthSchema = z
  .object({ status: z.literal('ok'), service: z.literal('kinto-api') })
  .strict();
export type Health = z.infer<typeof healthSchema>;

// Internal input from the verified OIDC/session adapter, never request JSON.
export const authenticatedIdentitySchema = z.strictObject({
  issuer: z.url().max(512),
  subject: z.string().min(1).max(255),
  mfaVerified: z.boolean(),
});
export type AuthenticatedIdentity = z.infer<typeof authenticatedIdentitySchema>;
export const tenantRoleSchema = z.enum([
  'owner',
  'hr_admin',
  'payroll_preparer',
  'payroll_approver',
  'employee',
]);
export const administrativeTenantRoleSchema = z.enum([
  'owner',
  'hr_admin',
  'payroll_preparer',
  'payroll_approver',
]);
const administrativeRoleOrder = administrativeTenantRoleSchema.options;
export const membershipRoleUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  roles: administrativeTenantRoleSchema
    .array()
    .min(1)
    .max(administrativeRoleOrder.length)
    .refine((roles) => new Set(roles).size === roles.length)
    .transform((roles) =>
      administrativeRoleOrder.filter((role) => roles.includes(role)),
    ),
  reason: z.string().trim().min(3).max(240),
});
export type MembershipRoleUpdate = z.infer<typeof membershipRoleUpdateSchema>;
export const membershipRevocationSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(240),
});
export type MembershipRevocation = z.infer<typeof membershipRevocationSchema>;
export const administratorInvitationSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  roles: administrativeTenantRoleSchema
    .array()
    .min(1)
    .max(administrativeRoleOrder.length)
    .refine((roles) => new Set(roles).size === roles.length)
    .transform((roles) =>
      administrativeRoleOrder.filter((role) => roles.includes(role)),
    ),
  reason: z.string().trim().min(3).max(240),
});
export type AdministratorInvitation = z.infer<
  typeof administratorInvitationSchema
>;

export const companyProvisioningSchema = z.strictObject({
  companyName: z.string().trim().min(1).max(160),
  employeeLimit: z.number().int().min(0).max(250),
  billingMode: z.enum(['free', 'complimentary', 'manual_paid']),
  initialOwnerEmail: z.string().trim().toLowerCase().pipe(z.email().max(320)),
});
export type CompanyProvisioning = z.infer<typeof companyProvisioningSchema>;
export const employeeAccountProvisioningSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
});
export type EmployeeAccountProvisioning = z.infer<
  typeof employeeAccountProvisioningSchema
>;
