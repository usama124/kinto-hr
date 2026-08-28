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

// Internal input from the future verified OIDC/session adapter, never request JSON.
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
