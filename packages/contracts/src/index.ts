import { z } from 'zod';
export const tenantIdSchema = z.uuid();
export const tenantSelectionSchema = z.strictObject({
  tenantId: tenantIdSchema,
});
export type TenantSelection = z.infer<typeof tenantSelectionSchema>;
export const pakistanProvinceCodeSchema = z.enum([
  'PK-BA',
  'PK-GB',
  'PK-IS',
  'PK-JK',
  'PK-KP',
  'PK-PB',
  'PK-SD',
]);
const organizationReasonSchema = z.string().trim().min(3).max(240);
const registrationIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ./_-]*$/)
  .optional();
const legalEntityFields = {
  legalName: z.string().trim().min(1).max(160),
  registrationNumber: registrationIdentifierSchema,
  taxNumber: registrationIdentifierSchema,
  provinceCode: pakistanProvinceCodeSchema,
};
export const legalEntityCreateSchema = z.strictObject({
  ...legalEntityFields,
  reason: organizationReasonSchema,
});
export const legalEntityUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  ...legalEntityFields,
  reason: organizationReasonSchema,
});
export type LegalEntityCreate = z.infer<typeof legalEntityCreateSchema>;
export type LegalEntityUpdate = z.infer<typeof legalEntityUpdateSchema>;
const branchFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
  name: z.string().trim().min(1).max(160),
  provinceCode: pakistanProvinceCodeSchema,
};
export const branchCreateSchema = z.strictObject({
  ...branchFields,
  reason: organizationReasonSchema,
});
export const branchUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  ...branchFields,
  status: z.enum(['active', 'inactive']),
  reason: organizationReasonSchema,
});
export type BranchCreate = z.infer<typeof branchCreateSchema>;
export type BranchUpdate = z.infer<typeof branchUpdateSchema>;
const organizationCatalogFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/),
  name: z.string().trim().min(1).max(160),
};
export const organizationCatalogCreateSchema = z.strictObject({
  ...organizationCatalogFields,
  reason: organizationReasonSchema,
});
export const organizationCatalogUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  ...organizationCatalogFields,
  status: z.enum(['active', 'inactive']),
  reason: organizationReasonSchema,
});
export type OrganizationCatalogCreate = z.infer<
  typeof organizationCatalogCreateSchema
>;
export type OrganizationCatalogUpdate = z.infer<
  typeof organizationCatalogUpdateSchema
>;
export const organizationPolicySettingsSchema = z.strictObject({
  defaultBranchId: tenantIdSchema,
});
export const organizationPolicyDraftSchema = z.strictObject({
  expectedCurrentVersion: z.number().int().min(0),
  effectiveFrom: z.iso.date(),
  settings: organizationPolicySettingsSchema,
  reason: organizationReasonSchema,
});
export const organizationPolicyPublishSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  reason: organizationReasonSchema,
});
export type OrganizationPolicyDraft = z.infer<
  typeof organizationPolicyDraftSchema
>;
export type OrganizationPolicyPublish = z.infer<
  typeof organizationPolicyPublishSchema
>;
export const legalEntityViewSchema = z.strictObject({
  id: tenantIdSchema,
  legalName: z.string().min(1).max(160),
  registrationNumber: z.string().max(80).nullable(),
  taxNumber: z.string().max(80).nullable(),
  countryCode: z.literal('PK'),
  currencyCode: z.literal('PKR'),
  timeZone: z.literal('Asia/Karachi'),
  provinceCode: pakistanProvinceCodeSchema,
  version: z.number().int().positive(),
});
export const branchViewSchema = z.strictObject({
  id: tenantIdSchema,
  legalEntityId: tenantIdSchema,
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(160),
  provinceCode: pakistanProvinceCodeSchema,
  status: z.enum(['active', 'inactive']),
  version: z.number().int().positive(),
});
export const organizationCatalogViewSchema = z.strictObject({
  id: tenantIdSchema,
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(160),
  status: z.enum(['active', 'inactive']),
  version: z.number().int().positive(),
});
const organizationPolicyViewSchema = z.strictObject({
  id: tenantIdSchema,
  version: z.number().int().positive(),
  effectiveFrom: z.iso.date(),
  settings: organizationPolicySettingsSchema,
});
export const organizationPolicyDraftViewSchema = organizationPolicyViewSchema
  .extend({
    basedOnVersion: z.number().int().min(0),
    reason: z.string().min(3).max(240),
  })
  .strict();
export const organizationSnapshotSchema = z.strictObject({
  legalEntity: legalEntityViewSchema.nullable(),
  branches: branchViewSchema.array().max(250),
  departments: organizationCatalogViewSchema.array().max(250),
  designations: organizationCatalogViewSchema.array().max(250),
  latestPublishedVersion: z.number().int().min(0),
  publishedPolicy: organizationPolicyViewSchema.nullable(),
  policyDrafts: organizationPolicyDraftViewSchema.array().max(20),
});
export const organizationPolicyPreviewSchema = z.strictObject({
  id: tenantIdSchema,
  version: z.number().int().positive(),
  basedOnVersion: z.number().int().min(0),
  effectiveFrom: z.iso.date(),
  defaultBranch: z.strictObject({
    id: tenantIdSchema,
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(160),
  }),
  affectedOpenPeriods: z.array(z.never()).length(0),
});
export type OrganizationSnapshot = z.infer<typeof organizationSnapshotSchema>;
const auditActionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_.]*$/);
const auditDateSchema = z.iso.datetime({ offset: true });
export const securityAuditQuerySchema = z
  .strictObject({
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .transform(Number)
      .optional(),
    action: auditActionSchema.optional(),
    from: auditDateSchema.optional(),
    to: auditDateSchema.optional(),
    cursor: z
      .string()
      .length(48)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .refine(
    ({ from, to }) => !from || !to || Date.parse(from) <= Date.parse(to),
    { message: 'from must not be later than to' },
  );
export type SecurityAuditQuery = z.infer<typeof securityAuditQuerySchema>;
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
const employeeNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9_-]*$/);
const employeeNameSchema = z.string().trim().min(1).max(160);
const employeeReasonSchema = z.string().trim().min(3).max(240);
const employeeOrganizationFields = {
  branchId: tenantIdSchema,
  departmentId: tenantIdSchema,
  designationId: tenantIdSchema,
  managerEmployeeId: tenantIdSchema.nullable(),
  topLevelReason: z.string().trim().min(3).max(240).optional(),
};
function validateReportingException(
  value: { managerEmployeeId: string | null; topLevelReason?: string },
  context: z.RefinementCtx,
) {
  if (value.managerEmployeeId === null && !value.topLevelReason)
    context.addIssue({
      code: 'custom',
      path: ['topLevelReason'],
      message: 'A top-level reporting exception is required',
    });
  if (value.managerEmployeeId !== null && value.topLevelReason)
    context.addIssue({
      code: 'custom',
      path: ['topLevelReason'],
      message: 'A reporting exception cannot be combined with a manager',
    });
}
export const employeeRecordCreateSchema = z
  .strictObject({
    employeeNumber: employeeNumberSchema,
    name: employeeNameSchema,
    legalName: employeeNameSchema.optional(),
    joiningDate: z.iso.date(),
    employmentType: z.literal('monthly_salaried'),
    ...employeeOrganizationFields,
    reason: employeeReasonSchema,
  })
  .superRefine(validateReportingException);
export const employeeProfileUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  name: employeeNameSchema,
  legalName: employeeNameSchema.optional(),
  reason: employeeReasonSchema,
});
export const employeeActivationSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  reason: employeeReasonSchema,
});
export const employeeTerminationSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  finalWorkingDate: z.iso.date(),
  reason: employeeReasonSchema,
});
export const employeeArchiveSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  reason: employeeReasonSchema,
});
export const employeeRehireSchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    joiningDate: z.iso.date(),
    ...employeeOrganizationFields,
    reason: employeeReasonSchema,
  })
  .superRefine(validateReportingException);
export const employeeAssignmentCreateSchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    effectiveFrom: z.iso.date(),
    ...employeeOrganizationFields,
    reason: employeeReasonSchema,
  })
  .superRefine(validateReportingException);
export type EmployeeRecordCreate = z.infer<typeof employeeRecordCreateSchema>;
export type EmployeeProfileUpdate = z.infer<typeof employeeProfileUpdateSchema>;
export type EmployeeActivation = z.infer<typeof employeeActivationSchema>;
export type EmployeeTermination = z.infer<typeof employeeTerminationSchema>;
export type EmployeeArchive = z.infer<typeof employeeArchiveSchema>;
export type EmployeeRehire = z.infer<typeof employeeRehireSchema>;
export type EmployeeAssignmentCreate = z.infer<
  typeof employeeAssignmentCreateSchema
>;
const employeeAssignmentViewSchema = z.strictObject({
  id: tenantIdSchema,
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable(),
  branch: z.strictObject({
    id: tenantIdSchema,
    code: z.string(),
    name: z.string(),
  }),
  department: z.strictObject({
    id: tenantIdSchema,
    code: z.string(),
    name: z.string(),
  }),
  designation: z.strictObject({
    id: tenantIdSchema,
    code: z.string(),
    name: z.string(),
  }),
  manager: z
    .strictObject({
      id: tenantIdSchema,
      employeeNumber: z.string(),
      name: z.string(),
    })
    .nullable(),
  topLevelReason: z.string().max(240).nullable(),
});
const employmentPeriodViewSchema = z.strictObject({
  id: tenantIdSchema,
  periodNumber: z.number().int().positive(),
  joiningDate: z.iso.date(),
  finalWorkingDate: z.iso.date().nullable(),
  status: z.enum(['planned', 'active', 'ended']),
});
export const employeeRecordViewSchema = z.strictObject({
  id: tenantIdSchema,
  employeeNumber: employeeNumberSchema,
  name: employeeNameSchema,
  legalName: employeeNameSchema.nullable(),
  status: z.enum(['draft', 'active', 'terminated', 'archived']),
  version: z.number().int().positive(),
  joiningDate: z.iso.date(),
  employmentType: z.literal('monthly_salaried'),
  payrollSetup: z.enum(['incomplete', 'complete']),
  finalWorkingDate: z.iso.date().nullable(),
  archivedAt: z.iso.datetime({ offset: true }).nullable(),
  employmentHistory: employmentPeriodViewSchema.array().max(250),
  currentAssignment: employeeAssignmentViewSchema.nullable(),
  assignmentHistory: employeeAssignmentViewSchema.array().max(250),
});
export const employeeRosterSchema = z.strictObject({
  employees: employeeRecordViewSchema.array().max(1000),
});
export type EmployeeRecordView = z.infer<typeof employeeRecordViewSchema>;
export type EmployeeRoster = z.infer<typeof employeeRosterSchema>;
const privatePhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 -]{7,20}$/)
  .transform((value) => value.replaceAll(' ', '').replaceAll('-', ''));
const privateNullableText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable();
export const employeePrivateDetailsUpdateSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(0),
    personalEmail: z.string().trim().toLowerCase().pipe(z.email()).nullable(),
    mobilePhone: privatePhoneSchema.nullable(),
    residentialAddress: privateNullableText(500),
    emergencyContactName: privateNullableText(160),
    emergencyContactPhone: privatePhoneSchema.nullable(),
    cnic: z
      .string()
      .trim()
      .regex(/^(?:[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9])$/)
      .transform((value) => value.replaceAll('-', ''))
      .nullable(),
    reason: employeeReasonSchema,
  })
  .superRefine((value, context) => {
    if (
      (value.emergencyContactName === null) !==
      (value.emergencyContactPhone === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['emergencyContactPhone'],
        message: 'Emergency contact name and phone must be supplied together',
      });
    if (
      [
        value.personalEmail,
        value.mobilePhone,
        value.residentialAddress,
        value.emergencyContactName,
        value.cnic,
      ].every((field) => field === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['personalEmail'],
        message: 'At least one private detail is required',
      });
  });
export const employeePrivateDetailsViewSchema = z.strictObject({
  id: tenantIdSchema,
  version: z.number().int().positive(),
  personalEmail: z.email().nullable(),
  mobilePhone: z.string().nullable(),
  residentialAddress: z.string().max(500).nullable(),
  emergencyContactName: z.string().max(160).nullable(),
  emergencyContactPhone: z.string().nullable(),
  cnic: z
    .string()
    .regex(/^[0-9]{13}$/)
    .nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const employeePrivateDetailsResponseSchema = z.strictObject({
  details: employeePrivateDetailsViewSchema.nullable(),
});
export type EmployeePrivateDetailsUpdate = z.infer<
  typeof employeePrivateDetailsUpdateSchema
>;
export type EmployeePrivateDetailsResponse = z.infer<
  typeof employeePrivateDetailsResponseSchema
>;
const compensationAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/)
  .refine((value) => !/^0(?:\.0{1,2})?$/.test(value), {
    message: 'Amount must be greater than zero',
  });
const compensationComponentInputSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1)
    .max(30)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['basic_salary', 'allowance', 'deduction']),
  monthlyAmount: compensationAmountSchema,
});
export const employeeCompensationRevisionSchema = z
  .strictObject({
    expectedAgreementVersion: z.number().int().min(0),
    effectiveFrom: z.iso.date(),
    components: compensationComponentInputSchema.array().min(1).max(30),
    reason: employeeReasonSchema,
  })
  .superRefine((value, context) => {
    const codes = value.components.map(({ code }) => code);
    if (new Set(codes).size !== codes.length)
      context.addIssue({
        code: 'custom',
        path: ['components'],
        message: 'Component codes must be unique',
      });
    if (
      value.components.filter(({ kind }) => kind === 'basic_salary').length !==
      1
    )
      context.addIssue({
        code: 'custom',
        path: ['components'],
        message: 'Exactly one basic salary component is required',
      });
  });
const compensationRevisionViewSchema = z.strictObject({
  revision: z.number().int().positive(),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullable(),
  components: compensationComponentInputSchema.array().min(1).max(30),
  createdAt: z.iso.datetime({ offset: true }),
});
export const employeeCompensationResponseSchema = z.strictObject({
  agreement: z
    .strictObject({
      id: tenantIdSchema,
      employeeId: tenantIdSchema,
      currencyCode: z.literal('PKR'),
      version: z.number().int().positive(),
      revisions: compensationRevisionViewSchema.array().min(1).max(250),
    })
    .nullable(),
});
export type EmployeeCompensationRevision = z.infer<
  typeof employeeCompensationRevisionSchema
>;
export type EmployeeCompensationResponse = z.infer<
  typeof employeeCompensationResponseSchema
>;
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

export const companyProvisioningSchema = z
  .strictObject({
    companyName: z.string().trim().min(1).max(160),
    employeeLimit: z.union([
      z.literal(5),
      z.literal(20),
      z.literal(50),
      z.literal(100),
      z.literal(250),
    ]),
    billingMode: z.enum(['free', 'complimentary', 'manual_paid']),
    initialOwnerEmail: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  })
  .superRefine((value, context) => {
    if (value.billingMode === 'free' && value.employeeLimit !== 5)
      context.addIssue({
        code: 'custom',
        path: ['employeeLimit'],
        message: 'Free provisioning requires the five-employee package',
      });
  });
export type CompanyProvisioning = z.infer<typeof companyProvisioningSchema>;
export const entitlementSnapshotSchema = z.strictObject({
  plan: z.strictObject({
    code: z.enum(['free', 'starter', 'growth', 'business', 'scale']),
    version: z.number().int().positive(),
  }),
  billingMode: z.enum(['free', 'complimentary', 'manual_paid']),
  employeeLimit: z.number().int().min(0).max(250),
  activeEmployees: z.number().int().min(0),
  availableEmployeeSeats: z.number().int().min(0),
  capabilities: z.strictObject({ companySetup: z.literal(true) }),
  entitlementVersion: z.number().int().positive(),
  effectiveFrom: z.iso.datetime({ offset: true }),
});
export type EntitlementSnapshot = z.infer<typeof entitlementSnapshotSchema>;
const entitlementChangeReasonSchema = z.string().trim().min(3).max(240);
const entitlementIntervalFields = {
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: entitlementChangeReasonSchema,
};
export const entitlementChangeSchema = z
  .discriminatedUnion('changeType', [
    z.strictObject({
      changeType: z.literal('capacity_addon'),
      seatDelta: z.number().int().min(1).max(250),
      ...entitlementIntervalFields,
    }),
    z.strictObject({
      changeType: z.literal('complimentary'),
      employeeLimit: z.union([
        z.literal(5),
        z.literal(20),
        z.literal(50),
        z.literal(100),
        z.literal(250),
      ]),
      ...entitlementIntervalFields,
    }),
    z.strictObject({
      changeType: z.literal('employee_limit_override'),
      employeeLimit: z.number().int().min(0).max(250),
      ...entitlementIntervalFields,
    }),
  ])
  .superRefine((value, context) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      context.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End must be later than start',
      });
  });
export type EntitlementChange = z.infer<typeof entitlementChangeSchema>;
export const entitlementRevocationSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  reason: entitlementChangeReasonSchema,
});
export type EntitlementRevocation = z.infer<typeof entitlementRevocationSchema>;
export const entitlementChangeResultSchema = z.strictObject({
  id: tenantIdSchema,
  version: z.number().int().positive(),
  entitlementVersion: z.number().int().positive(),
});
export const entitlementPreviewSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  before: entitlementSnapshotSchema,
  after: entitlementSnapshotSchema,
  changes: z.strictObject({
    employeeLimit: z.boolean(),
    billingMode: z.boolean(),
  }),
});
export const employeeAccountProvisioningSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
});
export type EmployeeAccountProvisioning = z.infer<
  typeof employeeAccountProvisioningSchema
>;
