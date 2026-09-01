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
    assertCanActivate(
      await tx.employee.count({ where: { tenantId, status: 'active' } }),
      tenant.employeeLimit,
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
