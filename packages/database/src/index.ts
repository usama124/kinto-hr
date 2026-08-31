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
// pre-provisioned first-owner invitation after trusted MFA. It never creates a
// provider identity or tenant; company authorization remains in inAuthorizedTenant.
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
      { identity_id: string; owner_activated: boolean }[]
    >`SELECT * FROM public.resolve_login_identity(
      ${principal.issuer}::varchar,
      ${principal.subject}::varchar,
      ${principal.mfaVerified},
      ${invitationId ?? null}::uuid,
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
