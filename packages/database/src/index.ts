import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  employeeDraftSchema,
  tenantIdSchema,
  type EmployeeDraft,
  authenticatedIdentitySchema,
  tenantRoleSchema,
  type AuthenticatedIdentity,
  companyProvisioningSchema,
  type CompanyProvisioning,
  employeeAccountProvisioningSchema,
  type EmployeeAccountProvisioning,
  membershipRoleUpdateSchema,
  type MembershipRoleUpdate,
  membershipRevocationSchema,
  type MembershipRevocation,
  administratorInvitationSchema,
  type AdministratorInvitation,
  type SecurityAuditQuery,
  legalEntityCreateSchema,
  legalEntityUpdateSchema,
  branchCreateSchema,
  branchUpdateSchema,
  organizationCatalogCreateSchema,
  organizationCatalogUpdateSchema,
  organizationPolicyDraftSchema,
  organizationPolicyPublishSchema,
  organizationSnapshotSchema,
  organizationPolicyPreviewSchema,
  entitlementSnapshotSchema,
  entitlementChangeSchema,
  entitlementRevocationSchema,
  entitlementChangeResultSchema,
  entitlementPreviewSchema,
  type LegalEntityCreate,
  type LegalEntityUpdate,
  type BranchCreate,
  type BranchUpdate,
  type OrganizationCatalogCreate,
  type OrganizationCatalogUpdate,
  type OrganizationPolicyDraft,
  type OrganizationPolicyPublish,
  type EntitlementChange,
  type EntitlementRevocation,
  employeeRecordCreateSchema,
  employeeProfileUpdateSchema,
  employeeAssignmentCreateSchema,
  employeeRecordViewSchema,
  employeeRosterSchema,
  type EmployeeRecordCreate,
  type EmployeeProfileUpdate,
  type EmployeeAssignmentCreate,
} from '@kinto/contracts';
import {
  assertCanActivate,
  assertDraftActivation,
  DomainError,
  hasPermission,
  type Permission,
} from '@kinto/domain';
export { PrismaClient };
export function createDatabase(url: string): PrismaClient {
  if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol))
    throw new Error('PostgreSQL URL required');
  return new PrismaClient({ datasources: { db: { url } }, log: [] });
}
export async function assertSafeRuntimeRole(db: PrismaClient): Promise<void> {
  const rows = await db.$queryRaw<{ unsafe: boolean }[]>`
    SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_has_role(current_user, c.relowner, 'MEMBER')
    ) AS unsafe FROM pg_roles r WHERE r.rolname = current_user
  `;
  if (rows.length !== 1 || rows[0].unsafe)
    throw new Error('Unsafe runtime database role');
}
export async function discoverIdentityTenants(
  db: PrismaClient,
  identityId: string,
) {
  tenantIdSchema.parse(identityId);
  const rows = await db.$queryRaw<
    {
      tenant_id: string;
      tenant_name: string;
      membership_id: string;
      membership_roles: string[];
    }[]
  >`SELECT * FROM public.discover_identity_tenants(${identityId}::uuid)`;
  return rows.map((row) => ({
    id: row.tenant_id,
    name: row.tenant_name,
    membershipId: row.membership_id,
    roles: tenantRoleSchema.array().parse(row.membership_roles),
  }));
}
// Login resolves an active identity and may atomically accept its single
// pre-provisioned owner or employee invitation after trusted MFA. It never
// creates a provider identity or tenant; company authorization remains in
// inAuthorizedTenant.
export async function findActiveIdentity(
  db: PrismaClient,
  authenticatedIdentity: AuthenticatedIdentity,
  invitationId?: string,
): Promise<{ id: string; ownerActivated: boolean } | null> {
  const principal = authenticatedIdentitySchema.parse(authenticatedIdentity);
  if (invitationId) tenantIdSchema.parse(invitationId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.identity_issuer', ${principal.issuer}, true), set_config('app.identity_subject', ${principal.subject}, true)`;
    const rows = await tx.$queryRaw<
      {
        identity_id: string;
        owner_activated: boolean;
        employee_activated: boolean;
      }[]
    >`SELECT * FROM public.resolve_login_identity(
      ${principal.issuer}::varchar,
      ${principal.subject}::varchar,
      ${principal.mfaVerified},
      ${invitationId ?? null}::uuid,
      ${randomUUID()}::uuid,
      ${randomUUID()}::uuid,
      ${randomUUID()}::uuid,
      ${randomUUID()}::uuid
    )`;
    return rows[0]
      ? {
          id: rows[0].identity_id,
          ownerActivated: rows[0].owner_activated,
        }
      : null;
  });
}

export async function reconcileEmployeeAccountProvider(
  db: PrismaClient,
  requestId: string,
  providerIdentity: { issuer: string; subject: string },
  expiresAt: Date,
) {
  tenantIdSchema.parse(requestId);
  const principal = authenticatedIdentitySchema.parse({
    ...providerIdentity,
    mfaVerified: false,
  });
  if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('CONFLICT');
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'existing' | 'not_found' | 'forbidden' | 'conflict';
      invitation_id: string | null;
      invitation_status: string | null;
      invitation_expires_at: Date | null;
    }[]
  >`SELECT * FROM public.reconcile_employee_account_provider(
    ${requestId}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${principal.issuer}::varchar,
    ${principal.subject}::varchar,
    ${expiresAt}::timestamptz,
    ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (
    !row.invitation_id ||
    !row.invitation_status ||
    !row.invitation_expires_at
  )
    throw new Error('Invalid employee provider reconciliation result');
  return {
    invitationId: row.invitation_id,
    status: row.invitation_status,
    expiresAt: row.invitation_expires_at,
    replayed: row.outcome === 'existing',
  };
}

export async function markEmployeeInvitationDelivered(
  db: PrismaClient,
  requestId: string,
  expiresAt: Date,
) {
  tenantIdSchema.parse(requestId);
  if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('CONFLICT');
  const rows = await db.$queryRaw<
    {
      outcome: 'updated' | 'existing' | 'not_found' | 'forbidden' | 'conflict';
      invitation_status: string | null;
    }[]
  >`SELECT * FROM public.mark_employee_invitation_delivered(
    ${requestId}::uuid,
    ${expiresAt}::timestamptz,
    ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (!row.invitation_status)
    throw new Error('Invalid employee invitation delivery result');
  return {
    status: row.invitation_status,
    replayed: row.outcome === 'existing',
  };
}

export async function requestAdministratorInvitation(
  db: PrismaClient,
  actor: { identityId: string; mfaVerified: boolean },
  tenantId: string,
  requestKey: string,
  input: AdministratorInvitation,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
  tenantIdSchema.parse(requestKey);
  const invitation = administratorInvitationSchema.parse(input);
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'existing' | 'forbidden' | 'conflict';
      account_request_id: string | null;
      provisioning_status: string | null;
    }[]
  >`SELECT * FROM public.request_administrator_invitation(
    ${actor.identityId}::uuid,
    ${actor.mfaVerified},
    ${tenantId}::uuid,
    ${requestKey}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${invitation.email}::varchar,
    ${invitation.roles}::text[],
    ${invitation.reason}::varchar
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (!row.account_request_id || !row.provisioning_status)
    throw new Error('Invalid administrator invitation result');
  return {
    accountRequestId: row.account_request_id,
    status: row.provisioning_status,
    replayed: row.outcome === 'existing',
  };
}

export async function reconcileAdministratorInvitationProvider(
  db: PrismaClient,
  requestId: string,
  providerIdentity: { issuer: string; subject: string },
  expiresAt: Date,
) {
  tenantIdSchema.parse(requestId);
  const principal = authenticatedIdentitySchema.parse({
    ...providerIdentity,
    mfaVerified: false,
  });
  if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('CONFLICT');
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'existing' | 'not_found' | 'forbidden' | 'conflict';
      invitation_id: string | null;
      invitation_status: string | null;
      invitation_expires_at: Date | null;
    }[]
  >`SELECT * FROM public.reconcile_administrator_invitation_provider(
    ${requestId}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${principal.issuer}::varchar,
    ${principal.subject}::varchar,
    ${expiresAt}::timestamptz,
    ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (
    !row.invitation_id ||
    !row.invitation_status ||
    !row.invitation_expires_at
  )
    throw new Error('Invalid administrator provider result');
  return {
    invitationId: row.invitation_id,
    status: row.invitation_status,
    expiresAt: row.invitation_expires_at,
    replayed: row.outcome === 'existing',
  };
}

export async function markAdministratorInvitationDelivered(
  db: PrismaClient,
  requestId: string,
  expiresAt: Date,
) {
  tenantIdSchema.parse(requestId);
  if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('CONFLICT');
  const rows = await db.$queryRaw<
    {
      outcome: 'updated' | 'existing' | 'not_found' | 'forbidden' | 'conflict';
      invitation_status: string | null;
    }[]
  >`SELECT * FROM public.mark_administrator_invitation_delivered(
    ${requestId}::uuid, ${expiresAt}::timestamptz, ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (!row.invitation_status)
    throw new Error('Invalid administrator delivery result');
  return {
    status: row.invitation_status,
    replayed: row.outcome === 'existing',
  };
}

export async function reconcileCompanyOwnerProvider(
  db: PrismaClient,
  requestId: string,
  providerIdentity: { issuer: string; subject: string },
  expiresAt: Date,
) {
  tenantIdSchema.parse(requestId);
  const principal = authenticatedIdentitySchema.parse({
    ...providerIdentity,
    mfaVerified: false,
  });
  if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('CONFLICT');
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'existing' | 'not_found' | 'forbidden' | 'conflict';
      invitation_id: string | null;
      invitation_status: string | null;
      invitation_expires_at: Date | null;
    }[]
  >`SELECT * FROM public.reconcile_company_owner_provider(
    ${requestId}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${principal.issuer}::varchar,
    ${principal.subject}::varchar,
    ${expiresAt}::timestamptz,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (
    !row.invitation_id ||
    !row.invitation_status ||
    !row.invitation_expires_at
  )
    throw new Error('Invalid provider reconciliation result');
  return {
    invitationId: row.invitation_id,
    status: row.invitation_status,
    expiresAt: row.invitation_expires_at,
    replayed: row.outcome === 'existing',
  };
}

export async function markCompanyOwnerInvitationDelivered(
  db: PrismaClient,
  requestId: string,
  expiresAt: Date,
) {
  tenantIdSchema.parse(requestId);
  if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('CONFLICT');
  const rows = await db.$queryRaw<
    {
      outcome: 'updated' | 'existing' | 'not_found' | 'forbidden' | 'conflict';
      invitation_status: string | null;
    }[]
  >`SELECT * FROM public.mark_company_owner_invitation_delivered(
    ${requestId}::uuid,
    ${expiresAt}::timestamptz,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (!row.invitation_status)
    throw new Error('Invalid invitation delivery result');
  return {
    status: row.invitation_status,
    replayed: row.outcome === 'existing',
  };
}
// Membership must be authenticated before this persistence boundary is called.
// No employee HTTP endpoint is exposed in the foundation release.
export async function inTenant<T>(
  db: PrismaClient,
  tenantId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  tenantIdSchema.parse(tenantId);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.status !== 'active')
      throw new DomainError('TENANT_UNAVAILABLE');
    return work(tx);
  });
}

// Not an authentication mechanism: only a verified server-side identity may enter
// here. Future HTTP handlers must not populate this from headers/body/query data.
// Keep ALL authorized work in the supplied transaction; do not authorize here and
// then call an unscoped helper in a second transaction.
export async function inAuthorizedTenant<T>(
  db: PrismaClient,
  authenticatedIdentity: AuthenticatedIdentity,
  tenantId: string,
  permission: Permission,
  work: (
    tx: Prisma.TransactionClient,
    actor: { identityId: string; membershipId: string },
  ) => Promise<T>,
): Promise<T> {
  const principal = authenticatedIdentitySchema.parse(authenticatedIdentity);
  return inTenant(db, tenantId, async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.identity_issuer', ${principal.issuer}, true), set_config('app.identity_subject', ${principal.subject}, true)`;
    const identity = await tx.identity.findUnique({
      where: {
        issuer_subject: {
          issuer: principal.issuer,
          subject: principal.subject,
        },
      },
    });
    if (!identity || identity.status !== 'active')
      throw new DomainError('FORBIDDEN');
    const membership = await tx.membership.findUnique({
      where: { tenantId_identityId: { tenantId, identityId: identity.id } },
    });
    if (!membership || membership.status !== 'active')
      throw new DomainError('FORBIDDEN');
    const roles = tenantRoleSchema
      .array()
      .min(1)
      .max(5)
      .parse(membership.roles);
    if (
      !hasPermission(roles, permission) ||
      (roles.some((role) => role !== 'employee') && !principal.mfaVerified)
    )
      throw new DomainError('FORBIDDEN');
    return work(tx, { identityId: identity.id, membershipId: membership.id });
  });
}

export async function requestCompanyProvisioning(
  db: PrismaClient,
  actor: { identityId: string; mfaVerified: boolean },
  requestKey: string,
  input: CompanyProvisioning,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(requestKey);
  const company = companyProvisioningSchema.parse(input);
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'existing' | 'forbidden' | 'conflict';
      tenant_id: string | null;
      provisioning_request_id: string | null;
      provisioning_status: string | null;
    }[]
  >`SELECT * FROM public.request_company_provisioning(
    ${actor.identityId}::uuid,
    ${actor.mfaVerified},
    ${requestKey}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${company.companyName}::varchar,
    ${company.employeeLimit}::integer,
    ${company.billingMode}::varchar,
    ${company.initialOwnerEmail}::varchar
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (
    !row.tenant_id ||
    !row.provisioning_request_id ||
    !row.provisioning_status
  )
    throw new Error('Invalid provisioning result');
  return {
    tenantId: row.tenant_id,
    provisioningRequestId: row.provisioning_request_id,
    status: row.provisioning_status,
    replayed: row.outcome === 'existing',
  };
}
export async function requestEmployeeAccountProvisioning(
  db: PrismaClient,
  actor: { identityId: string; mfaVerified: boolean },
  tenantId: string,
  employeeId: string,
  requestKey: string,
  input: EmployeeAccountProvisioning,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
  tenantIdSchema.parse(employeeId);
  tenantIdSchema.parse(requestKey);
  const account = employeeAccountProvisioningSchema.parse(input);
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'existing' | 'forbidden' | 'not_found' | 'conflict';
      account_request_id: string | null;
      provisioning_status: string | null;
    }[]
  >`SELECT * FROM public.request_employee_account_provisioning(
    ${actor.identityId}::uuid,
    ${actor.mfaVerified},
    ${tenantId}::uuid,
    ${employeeId}::uuid,
    ${requestKey}::uuid,
    ${randomUUID()}::uuid,
    ${randomUUID()}::uuid,
    ${account.email}::varchar
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (!row.account_request_id || !row.provisioning_status)
    throw new Error('Invalid employee account provisioning result');
  return {
    accountRequestId: row.account_request_id,
    status: row.provisioning_status,
    replayed: row.outcome === 'existing',
  };
}

type MembershipAdministrationActor = {
  identityId: string;
  mfaVerified: boolean;
};

export async function listTenantMemberships(
  db: PrismaClient,
  actor: MembershipAdministrationActor,
  tenantId: string,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
  const rows = await db.$queryRaw<
    {
      outcome: 'ok' | 'forbidden';
      membership_id: string | null;
      identity_id: string | null;
      membership_status: string | null;
      membership_roles: string[] | null;
      membership_version: number | null;
      employee_id: string | null;
      membership_created_at: Date | null;
    }[]
  >`SELECT * FROM public.list_tenant_memberships(
    ${actor.identityId}::uuid,
    ${actor.mfaVerified},
    ${tenantId}::uuid
  )`;
  if (rows[0]?.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  return rows.map((row) => {
    if (
      row.outcome !== 'ok' ||
      !row.membership_id ||
      !row.identity_id ||
      !row.membership_status ||
      !row.membership_roles ||
      !row.membership_version ||
      !row.membership_created_at
    )
      throw new Error('Invalid membership list result');
    return {
      id: row.membership_id,
      identityId: row.identity_id,
      status: row.membership_status,
      roles: tenantRoleSchema.array().min(1).max(5).parse(row.membership_roles),
      version: row.membership_version,
      employeeId: row.employee_id,
      createdAt: row.membership_created_at,
    };
  });
}

async function mutateTenantMembership(
  db: PrismaClient,
  actor: MembershipAdministrationActor,
  tenantId: string,
  membershipId: string,
  change: MembershipRoleUpdate | MembershipRevocation,
  revoke: boolean,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
  tenantIdSchema.parse(membershipId);
  const roles = 'roles' in change ? change.roles : null;
  const rows = await db.$queryRaw<
    {
      outcome:
        | 'updated'
        | 'forbidden'
        | 'not_found'
        | 'stale'
        | 'invalid_state'
        | 'employee_linked'
        | 'last_owner'
        | 'conflict';
      membership_status: string | null;
      membership_roles: string[] | null;
      membership_version: number | null;
    }[]
  >`SELECT * FROM public.mutate_tenant_membership(
    ${actor.identityId}::uuid,
    ${actor.mfaVerified},
    ${tenantId}::uuid,
    ${membershipId}::uuid,
    ${change.expectedVersion}::integer,
    ${roles}::text[],
    ${revoke},
    ${change.reason}::varchar,
    ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'stale') throw new DomainError('STALE_VERSION');
  if (
    row.outcome === 'invalid_state' ||
    row.outcome === 'employee_linked' ||
    row.outcome === 'last_owner'
  )
    throw new DomainError('INVALID_STATE');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (
    !row.membership_status ||
    !row.membership_roles ||
    !row.membership_version
  )
    throw new Error('Invalid membership mutation result');
  return {
    id: membershipId,
    status: row.membership_status,
    roles: tenantRoleSchema.array().min(1).max(5).parse(row.membership_roles),
    version: row.membership_version,
  };
}

export function updateTenantMembershipRoles(
  db: PrismaClient,
  actor: MembershipAdministrationActor,
  tenantId: string,
  membershipId: string,
  input: MembershipRoleUpdate,
) {
  return mutateTenantMembership(
    db,
    actor,
    tenantId,
    membershipId,
    membershipRoleUpdateSchema.parse(input),
    false,
  );
}

export function revokeTenantMembership(
  db: PrismaClient,
  actor: MembershipAdministrationActor,
  tenantId: string,
  membershipId: string,
  input: MembershipRevocation,
) {
  return mutateTenantMembership(
    db,
    actor,
    tenantId,
    membershipId,
    membershipRevocationSchema.parse(input),
    true,
  );
}

type SecurityAuditActor = { identityId: string; mfaVerified: boolean };

const encodeSecurityAuditCursor = (eventId: string) =>
  Buffer.from(eventId, 'utf8').toString('base64url');

function decodeSecurityAuditCursor(cursor?: string) {
  if (!cursor) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DomainError('CONFLICT');
  }
  if (
    encodeSecurityAuditCursor(decoded) !== cursor ||
    !tenantIdSchema.safeParse(decoded).success
  )
    throw new DomainError('CONFLICT');
  return decoded;
}

export async function listTenantSecurityAudit(
  db: PrismaClient,
  actor: SecurityAuditActor,
  tenantId: string,
  query: SecurityAuditQuery,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
  const limit = query.limit ?? 50;
  const cursorId = decodeSecurityAuditCursor(query.cursor);
  const rows = await db.$queryRaw<
    {
      outcome: 'ok' | 'forbidden' | 'not_found' | 'conflict';
      event_id: string | null;
      actor_id: string | null;
      action: string | null;
      reason: string | null;
      resource_id: string | null;
      event_created_at: Date | null;
    }[]
  >`SELECT * FROM public.list_tenant_security_audit(
    ${actor.identityId}::uuid,
    ${actor.mfaVerified},
    ${tenantId}::uuid,
    ${limit}::integer,
    ${query.action ?? null}::varchar,
    ${query.from ? new Date(query.from) : null}::timestamptz,
    ${query.to ? new Date(query.to) : null}::timestamptz,
    ${cursorId}::uuid
  )`;
  if (rows[0]?.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (rows[0]?.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (rows[0]?.outcome === 'conflict') throw new DomainError('CONFLICT');
  const items = rows.map((row) => {
    if (
      row.outcome !== 'ok' ||
      !row.event_id ||
      !row.actor_id ||
      !row.action ||
      !row.resource_id ||
      !row.event_created_at
    )
      throw new Error('Invalid security audit result');
    return {
      id: row.event_id,
      actorId: row.actor_id,
      action: row.action,
      reason: row.reason,
      resourceId: row.resource_id,
      createdAt: row.event_created_at,
    };
  });
  const page = items.slice(0, limit);
  return {
    items: page,
    nextCursor:
      items.length > limit && page.length
        ? encodeSecurityAuditCursor(page[page.length - 1].id)
        : null,
  };
}

type OrganizationActor = { identityId: string; mfaVerified: boolean };
type OrganizationMutationRow = {
  outcome:
    | 'created'
    | 'updated'
    | 'published'
    | 'forbidden'
    | 'not_found'
    | 'stale'
    | 'invalid_state'
    | 'conflict';
  entity_id?: string | null;
  entity_version?: number | null;
  branch_id?: string | null;
  branch_version?: number | null;
  policy_id?: string | null;
  policy_version?: number | null;
  resource_id?: string | null;
  resource_version?: number | null;
};

function validateOrganizationActor(actor: OrganizationActor, tenantId: string) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
}

function assertOrganizationMutation(row?: OrganizationMutationRow) {
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'stale') throw new DomainError('STALE_VERSION');
  if (row.outcome === 'invalid_state') throw new DomainError('INVALID_STATE');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  return row;
}

export async function readTenantOrganization(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
) {
  validateOrganizationActor(actor, tenantId);
  const rows = await db.$queryRaw<
    { outcome: 'ok' | 'forbidden'; snapshot: unknown }[]
  >`SELECT * FROM public.read_tenant_organization(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  return organizationSnapshotSchema.parse(row.snapshot);
}

export async function createTenantLegalEntity(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  input: LegalEntityCreate,
) {
  validateOrganizationActor(actor, tenantId);
  const value = legalEntityCreateSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.create_tenant_legal_entity(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${randomUUID()}::uuid, ${value.legalName}::varchar,
      ${value.registrationNumber ?? null}::varchar,
      ${value.taxNumber ?? null}::varchar, ${value.provinceCode}::varchar,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.entity_id || !row.entity_version)
    throw new Error('Invalid legal entity creation result');
  return { id: row.entity_id, version: row.entity_version };
}

export async function updateTenantLegalEntity(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  entityId: string,
  input: LegalEntityUpdate,
) {
  validateOrganizationActor(actor, tenantId);
  tenantIdSchema.parse(entityId);
  const value = legalEntityUpdateSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.update_tenant_legal_entity(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${entityId}::uuid, ${value.expectedVersion}::integer,
      ${value.legalName}::varchar, ${value.registrationNumber ?? null}::varchar,
      ${value.taxNumber ?? null}::varchar, ${value.provinceCode}::varchar,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.entity_id || !row.entity_version)
    throw new Error('Invalid legal entity update result');
  return { id: row.entity_id, version: row.entity_version };
}

export async function createTenantBranch(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  input: BranchCreate,
) {
  validateOrganizationActor(actor, tenantId);
  const value = branchCreateSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.create_tenant_branch(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${randomUUID()}::uuid, ${value.code}::varchar, ${value.name}::varchar,
      ${value.provinceCode}::varchar, ${value.reason}::varchar,
      ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.branch_id || !row.branch_version)
    throw new Error('Invalid branch creation result');
  return { id: row.branch_id, version: row.branch_version };
}

export async function updateTenantBranch(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  branchId: string,
  input: BranchUpdate,
) {
  validateOrganizationActor(actor, tenantId);
  tenantIdSchema.parse(branchId);
  const value = branchUpdateSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.update_tenant_branch(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${branchId}::uuid, ${value.expectedVersion}::integer,
      ${value.code}::varchar, ${value.name}::varchar,
      ${value.provinceCode}::varchar, ${value.status}::varchar,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.branch_id || !row.branch_version)
    throw new Error('Invalid branch update result');
  return { id: row.branch_id, version: row.branch_version };
}

export async function createTenantOrganizationCatalogEntry(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  catalog: 'department' | 'designation',
  input: OrganizationCatalogCreate,
) {
  validateOrganizationActor(actor, tenantId);
  const value = organizationCatalogCreateSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.mutate_organization_catalog(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${catalog}::varchar, ${randomUUID()}::uuid, NULL,
      ${value.code}::varchar, ${value.name}::varchar, 'active'::varchar,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.resource_id || !row.resource_version)
    throw new Error('Invalid organization catalog creation result');
  return { id: row.resource_id, version: row.resource_version };
}

export async function updateTenantOrganizationCatalogEntry(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  catalog: 'department' | 'designation',
  resourceId: string,
  input: OrganizationCatalogUpdate,
) {
  validateOrganizationActor(actor, tenantId);
  tenantIdSchema.parse(resourceId);
  const value = organizationCatalogUpdateSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.mutate_organization_catalog(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${catalog}::varchar, ${resourceId}::uuid,
      ${value.expectedVersion}::integer, ${value.code}::varchar,
      ${value.name}::varchar, ${value.status}::varchar, ${value.reason}::varchar,
      ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.resource_id || !row.resource_version)
    throw new Error('Invalid organization catalog update result');
  return { id: row.resource_id, version: row.resource_version };
}

export async function createOrganizationPolicyDraft(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  input: OrganizationPolicyDraft,
) {
  validateOrganizationActor(actor, tenantId);
  const value = organizationPolicyDraftSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.create_organization_policy_draft(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${randomUUID()}::uuid, ${value.expectedCurrentVersion}::integer,
      ${value.effectiveFrom}::date, ${value.settings.defaultBranchId}::uuid,
      ${value.reason}::varchar, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.policy_id || !row.policy_version)
    throw new Error('Invalid policy draft result');
  return { id: row.policy_id, version: row.policy_version };
}

export async function previewOrganizationPolicy(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  policyId: string,
) {
  validateOrganizationActor(actor, tenantId);
  tenantIdSchema.parse(policyId);
  const rows = await db.$queryRaw<
    { outcome: 'ok' | 'forbidden' | 'not_found'; preview: unknown }[]
  >`SELECT * FROM public.preview_organization_policy(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
    ${policyId}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  return organizationPolicyPreviewSchema.parse(row.preview);
}

export async function publishOrganizationPolicy(
  db: PrismaClient,
  actor: OrganizationActor,
  tenantId: string,
  policyId: string,
  input: OrganizationPolicyPublish,
) {
  validateOrganizationActor(actor, tenantId);
  tenantIdSchema.parse(policyId);
  const value = organizationPolicyPublishSchema.parse(input);
  const rows = await db.$queryRaw<OrganizationMutationRow[]>`
    SELECT * FROM public.publish_organization_policy(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${policyId}::uuid, ${value.expectedVersion}::integer,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  const row = assertOrganizationMutation(rows[0]);
  if (!row.policy_id || !row.policy_version)
    throw new Error('Invalid policy publication result');
  return { id: row.policy_id, version: row.policy_version };
}
export async function readTenantEntitlements(
  db: PrismaClient,
  actor: { identityId: string; mfaVerified: boolean },
  tenantId: string,
) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
  const rows = await db.$queryRaw<
    { outcome: 'ok' | 'forbidden' | 'not_found'; snapshot: unknown }[]
  >`SELECT * FROM public.read_tenant_entitlements(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  return entitlementSnapshotSchema.parse(row.snapshot);
}

type EntitlementActor = { identityId: string; mfaVerified: boolean };

function validateEntitlementActor(actor: EntitlementActor, tenantId: string) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
}

function entitlementParameters(input: EntitlementChange) {
  return {
    employeeLimit:
      input.changeType === 'capacity_addon' ? null : input.employeeLimit,
    seatDelta: input.changeType === 'capacity_addon' ? input.seatDelta : null,
  };
}

export async function previewEntitlementChange(
  db: PrismaClient,
  actor: EntitlementActor,
  tenantId: string,
  input: EntitlementChange,
) {
  validateEntitlementActor(actor, tenantId);
  const value = entitlementChangeSchema.parse(input);
  const parameters = entitlementParameters(value);
  const rows = await db.$queryRaw<
    {
      outcome: 'ok' | 'forbidden' | 'not_found' | 'conflict';
      preview: unknown;
    }[]
  >`SELECT * FROM public.preview_entitlement_change(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
    ${value.changeType}::varchar, ${new Date(value.startsAt)}::timestamptz,
    ${new Date(value.endsAt)}::timestamptz,
    ${parameters.employeeLimit}::integer, ${parameters.seatDelta}::integer
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  return entitlementPreviewSchema.parse(row.preview);
}

export async function createEntitlementChange(
  db: PrismaClient,
  actor: EntitlementActor,
  tenantId: string,
  input: EntitlementChange,
) {
  validateEntitlementActor(actor, tenantId);
  const value = entitlementChangeSchema.parse(input);
  const parameters = entitlementParameters(value);
  const rows = await db.$queryRaw<
    {
      outcome: 'created' | 'forbidden' | 'conflict';
      change_id: string | null;
      change_version: number | null;
      entitlement_version: number | null;
    }[]
  >`SELECT * FROM public.create_entitlement_change(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
    ${randomUUID()}::uuid, ${value.changeType}::varchar,
    ${new Date(value.startsAt)}::timestamptz, ${new Date(value.endsAt)}::timestamptz,
    ${parameters.employeeLimit}::integer, ${parameters.seatDelta}::integer,
    ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  return entitlementChangeResultSchema.parse({
    id: row.change_id,
    version: row.change_version,
    entitlementVersion: row.entitlement_version,
  });
}

export async function revokeEntitlementChange(
  db: PrismaClient,
  actor: EntitlementActor,
  tenantId: string,
  kind: 'grant' | 'override',
  changeId: string,
  input: EntitlementRevocation,
) {
  validateEntitlementActor(actor, tenantId);
  tenantIdSchema.parse(changeId);
  const value = entitlementRevocationSchema.parse(input);
  const rows = await db.$queryRaw<
    {
      outcome: 'revoked' | 'forbidden' | 'not_found' | 'stale' | 'conflict';
      change_id: string | null;
      change_version: number | null;
      entitlement_version: number | null;
    }[]
  >`SELECT * FROM public.revoke_entitlement_change(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
    ${kind}::varchar, ${changeId}::uuid, ${value.expectedVersion}::integer,
    ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
  )`;
  const row = rows[0];
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'stale') throw new DomainError('STALE_VERSION');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  return entitlementChangeResultSchema.parse({
    id: row.change_id,
    version: row.change_version,
    entitlementVersion: row.entitlement_version,
  });
}
export async function createEmployeeDraft(
  db: PrismaClient,
  tenantId: string,
  input: EmployeeDraft,
  actorId: string,
) {
  const draft = employeeDraftSchema.parse(input);
  tenantIdSchema.parse(actorId);
  return inTenant(db, tenantId, async (tx) => {
    const employee = await tx.employee.create({ data: { ...draft, tenantId } });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actorId,
        action: 'employee.draft_created',
        resourceId: employee.id,
      },
    });
    return employee;
  });
}

type PeopleActor = { identityId: string; mfaVerified: boolean };
type PeopleMutationRow = {
  outcome:
    | 'created'
    | 'updated'
    | 'forbidden'
    | 'not_found'
    | 'stale'
    | 'invalid_state'
    | 'conflict';
  employee_id: string | null;
  employee_version: number | null;
};
function validatePeopleActor(actor: PeopleActor, tenantId: string) {
  tenantIdSchema.parse(actor.identityId);
  tenantIdSchema.parse(tenantId);
}
function assertPeopleMutation(row?: PeopleMutationRow) {
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'stale') throw new DomainError('STALE_VERSION');
  if (row.outcome === 'invalid_state') throw new DomainError('INVALID_STATE');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (!row.employee_id || !row.employee_version)
    throw new Error('Invalid employee mutation result');
  return { id: row.employee_id, version: row.employee_version };
}
export async function readTenantEmployees(
  db: PrismaClient,
  actor: PeopleActor,
  tenantId: string,
) {
  validatePeopleActor(actor, tenantId);
  const rows = await db.$queryRaw<
    { outcome: 'ok' | 'forbidden'; snapshot: unknown }[]
  >`SELECT * FROM public.read_tenant_employees(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid, NULL::uuid
  )`;
  if (!rows[0] || rows[0].outcome === 'forbidden')
    throw new DomainError('FORBIDDEN');
  return employeeRosterSchema.parse(rows[0].snapshot);
}
export async function readTenantEmployee(
  db: PrismaClient,
  actor: PeopleActor,
  tenantId: string,
  employeeId: string,
) {
  validatePeopleActor(actor, tenantId);
  tenantIdSchema.parse(employeeId);
  const rows = await db.$queryRaw<
    { outcome: 'ok' | 'forbidden' | 'not_found'; snapshot: unknown }[]
  >`SELECT * FROM public.read_tenant_employees(
    ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid, ${employeeId}::uuid
  )`;
  if (!rows[0] || rows[0].outcome === 'forbidden')
    throw new DomainError('FORBIDDEN');
  if (rows[0].outcome === 'not_found') throw new DomainError('NOT_FOUND');
  return employeeRecordViewSchema.parse(rows[0].snapshot);
}
export async function createTenantEmployee(
  db: PrismaClient,
  actor: PeopleActor,
  tenantId: string,
  input: EmployeeRecordCreate,
) {
  validatePeopleActor(actor, tenantId);
  const value = employeeRecordCreateSchema.parse(input);
  const rows = await db.$queryRaw<PeopleMutationRow[]>`
    SELECT * FROM public.create_tenant_employee(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      ${value.employeeNumber}::varchar, ${value.name}::varchar,
      ${value.legalName ?? null}::varchar, ${value.joiningDate}::date,
      ${value.employmentType}::varchar, ${value.branchId}::uuid,
      ${value.departmentId}::uuid, ${value.designationId}::uuid,
      ${value.managerEmployeeId}::uuid, ${value.topLevelReason ?? null}::varchar,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  return assertPeopleMutation(rows[0]);
}
export async function updateTenantEmployeeProfile(
  db: PrismaClient,
  actor: PeopleActor,
  tenantId: string,
  employeeId: string,
  input: EmployeeProfileUpdate,
) {
  validatePeopleActor(actor, tenantId);
  tenantIdSchema.parse(employeeId);
  const value = employeeProfileUpdateSchema.parse(input);
  const rows = await db.$queryRaw<PeopleMutationRow[]>`
    SELECT * FROM public.update_tenant_employee_profile(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${employeeId}::uuid, ${value.expectedVersion}::integer,
      ${value.name}::varchar, ${value.legalName ?? null}::varchar,
      ${value.reason}::varchar, ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  return assertPeopleMutation(rows[0]);
}
export async function createTenantEmployeeAssignment(
  db: PrismaClient,
  actor: PeopleActor,
  tenantId: string,
  employeeId: string,
  input: EmployeeAssignmentCreate,
) {
  validatePeopleActor(actor, tenantId);
  tenantIdSchema.parse(employeeId);
  const value = employeeAssignmentCreateSchema.parse(input);
  const rows = await db.$queryRaw<PeopleMutationRow[]>`
    SELECT * FROM public.create_tenant_employee_assignment(
      ${actor.identityId}::uuid, ${actor.mfaVerified}, ${tenantId}::uuid,
      ${employeeId}::uuid, ${randomUUID()}::uuid,
      ${value.expectedVersion}::integer, ${value.effectiveFrom}::date,
      ${value.branchId}::uuid, ${value.departmentId}::uuid,
      ${value.designationId}::uuid, ${value.managerEmployeeId}::uuid,
      ${value.topLevelReason ?? null}::varchar, ${value.reason}::varchar,
      ${randomUUID()}::uuid, ${randomUUID()}::uuid
    )
  `;
  return assertPeopleMutation(rows[0]);
}
export async function activateEmployee(
  db: PrismaClient,
  tenantId: string,
  employeeId: string,
  version: number,
  actorId: string,
) {
  tenantIdSchema.parse(employeeId);
  tenantIdSchema.parse(actorId);
  return inTenant(db, tenantId, async (tx) => {
    // A transaction-scoped lock serializes capacity decisions, without plan UPDATE grants.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}::text, 0))::text`;
    const employee = await tx.employee.findUnique({
      where: { tenantId_id: { tenantId, id: employeeId } },
    });
    if (!employee) throw new DomainError('NOT_FOUND');
    assertDraftActivation(employee.status, employee.version, version);
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    if (tenant.status !== 'active') throw new DomainError('TENANT_UNAVAILABLE');
    const [entitlement] = await tx.$queryRaw<
      { employee_limit: number | null }[]
    >`SELECT public.current_tenant_employee_limit() AS employee_limit`;
    assertCanActivate(
      await tx.employee.count({ where: { tenantId, status: 'active' } }),
      entitlement?.employee_limit ?? tenant.employeeLimit,
    );
    const updated = await tx.employee.update({
      where: { tenantId_id: { tenantId, id: employeeId } },
      data: { status: 'active', version: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actorId,
        action: 'employee.activated',
        resourceId: employeeId,
      },
    });
    await tx.outboxEvent.create({
      data: {
        tenantId,
        type: 'employee.activated.v1',
        aggregateId: employeeId,
        aggregateVersion: updated.version,
      },
    });
    return updated;
  });
}
