import { PrismaClient, type Prisma } from '@prisma/client';
import {
  employeeDraftSchema,
  tenantIdSchema,
  type EmployeeDraft,
} from '@kinto/contracts';
import {
  assertCanActivate,
  assertDraftActivation,
  DomainError,
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
