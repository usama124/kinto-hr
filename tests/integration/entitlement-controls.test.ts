import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateEmployee,
  createDatabase,
  createEntitlementChange,
  previewEntitlementChange,
  readTenantEntitlements,
  revokeEntitlementChange,
} from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (
  !adminUrl ||
  !runtimeUrl ||
  [adminUrl, runtimeUrl].some(
    (url) => !new URL(url).pathname.startsWith('/kinto_test'),
  )
)
  throw new Error('Entitlement tests require synthetic kinto_test databases');

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let operatorId: string;
let nonOperatorId: string;

const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const interval = () => ({
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 86_400_000).toISOString(),
});

describe('dated entitlement grants and overrides', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    operatorId = randomUUID();
    nonOperatorId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic controlled entitlement company',
        employeeLimit: 250,
        billingMode: 'complimentary',
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, operatorId, nonOperatorId].map((id) => ({
        id,
        issuer: 'https://entitlement-controls.synthetic.example/realm',
        subject: randomUUID(),
      })),
    });
    await admin.platformOperator.create({ data: { identityId: operatorId } });
    await admin.membership.create({
      data: { tenantId, identityId: ownerId, roles: ['owner'] },
    });
    const free = await admin.planVersion.findFirstOrThrow({
      where: { code: 'free', planVersion: 1 },
    });
    await admin.tenantSubscription.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id: randomUUID(),
        tenantId: id,
        subscriptionVersion: 1,
        planVersionId: free.id,
        billingMode: 'free',
        employeeLimit: 5,
        reason: 'Synthetic free subscription',
      })),
    });
  });

  afterEach(async () => {
    const tenantIds = [tenantId, otherTenantId];
    await admin.platformAuditEvent.deleteMany({
      where: { actorId: { in: [operatorId, nonOperatorId] } },
    });
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.outboxEvent.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.employee.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await admin.membership.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await admin.platformOperator.deleteMany({
      where: { identityId: { in: [operatorId, nonOperatorId] } },
    });
    await admin.identity.deleteMany({
      where: { id: { in: [ownerId, operatorId, nonOperatorId] } },
    });
  });

  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('previews and applies additive capacity to activation under one entitlement version', async () => {
    await admin.employee.createMany({
      data: [1, 2, 3, 4, 5].map((number) => ({
        tenantId,
        employeeNumber: `ACTIVE-${number}`,
        name: `Active employee ${number}`,
        status: 'active',
      })),
    });
    const input = {
      changeType: 'capacity_addon' as const,
      seatDelta: 2,
      ...interval(),
      reason: 'Temporary approved headcount',
    };
    const preview = await previewEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
    );
    expect(preview.before.employeeLimit).toBe(5);
    expect(preview.after).toMatchObject({
      employeeLimit: 7,
      entitlementVersion: 2,
    });
    expect(preview.changes).toEqual({
      employeeLimit: true,
      billingMode: false,
    });
    const created = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
    );
    expect(created).toMatchObject({ version: 1, entitlementVersion: 2 });
    expect(
      await readTenantEntitlements(runtime, actor(ownerId), tenantId),
    ).toMatchObject({ employeeLimit: 7, activeEmployees: 5 });
    const draft = await admin.employee.create({
      data: { tenantId, employeeNumber: 'DRAFT-6', name: 'Sixth employee' },
    });
    await expect(
      activateEmployee(runtime, tenantId, draft.id, 1, ownerId),
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('makes complimentary access temporary without deleting over-cap employees on expiry', async () => {
    const input = {
      changeType: 'complimentary' as const,
      employeeLimit: 100 as const,
      ...interval(),
      reason: 'Approved pilot access',
    };
    await createEntitlementChange(runtime, actor(operatorId), tenantId, input);
    await admin.employee.createMany({
      data: [1, 2, 3, 4, 5, 6].map((number) => ({
        tenantId,
        employeeNumber: `PILOT-${number}`,
        name: `Pilot employee ${number}`,
        status: 'active',
      })),
    });
    expect(
      await readTenantEntitlements(runtime, actor(ownerId), tenantId),
    ).toMatchObject({ billingMode: 'complimentary', employeeLimit: 100 });
    const [expired] = await admin.$queryRaw<{ snapshot: unknown }[]>`
      SELECT public.resolve_tenant_entitlements_at(
        ${tenantId}::uuid, ${new Date(Date.now() + 172_800_000)}::timestamptz,
        NULL, NULL, NULL
      ) AS snapshot`;
    expect(expired.snapshot).toMatchObject({
      billingMode: 'free',
      employeeLimit: 5,
      activeEmployees: 6,
      availableEmployeeSeats: 0,
    });
    expect(
      await admin.employee.count({ where: { tenantId, status: 'active' } }),
    ).toBe(6);
  });

  it('gives an employee-limit override precedence and rejects overlapping active overrides', async () => {
    const addon = {
      changeType: 'capacity_addon' as const,
      seatDelta: 10,
      ...interval(),
      reason: 'Approved capacity add-on',
    };
    await createEntitlementChange(runtime, actor(operatorId), tenantId, addon);
    const override = {
      changeType: 'employee_limit_override' as const,
      employeeLimit: 3,
      ...interval(),
      reason: 'Temporary compliance restriction',
    };
    const created = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      override,
    );
    expect(created.entitlementVersion).toBe(3);
    expect(
      await readTenantEntitlements(runtime, actor(ownerId), tenantId),
    ).toMatchObject({ employeeLimit: 3, entitlementVersion: 3 });
    await expect(
      createEntitlementChange(runtime, actor(operatorId), tenantId, override),
    ).rejects.toThrow('CONFLICT');
    await expect(
      admin.entitlementOverride.create({
        data: {
          id: randomUUID(),
          tenantId,
          field: 'employee_limit',
          employeeLimit: 4,
          startsAt: new Date(override.startsAt),
          endsAt: new Date(override.endsAt),
          reason: 'Direct overlapping control test',
          createdByIdentityId: operatorId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      runtime.entitlementGrant.create({
        data: {
          id: randomUUID(),
          tenantId,
          kind: 'capacity_addon',
          seatDelta: 1,
          startsAt: new Date(override.startsAt),
          endsAt: new Date(override.endsAt),
          reason: 'Forbidden direct runtime write',
          createdByIdentityId: operatorId,
        },
      }),
    ).rejects.toThrow();
  });

  it('requires an active recent-MFA operator and revokes immutably with audit reasons', async () => {
    const input = {
      changeType: 'capacity_addon' as const,
      seatDelta: 4,
      ...interval(),
      reason: 'Approved seasonal capacity',
    };
    for (const caller of [
      actor(nonOperatorId),
      actor(ownerId),
      actor(operatorId, false),
    ])
      await expect(
        createEntitlementChange(runtime, caller, tenantId, input),
      ).rejects.toThrow('FORBIDDEN');
    await admin.platformOperator.update({
      where: { identityId: operatorId },
      data: { status: 'revoked' },
    });
    await expect(
      createEntitlementChange(runtime, actor(operatorId), tenantId, input),
    ).rejects.toThrow('FORBIDDEN');
    await admin.platformOperator.delete({ where: { identityId: operatorId } });
    await admin.platformOperator.create({ data: { identityId: operatorId } });
    const created = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
    );
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        otherTenantId,
        'grant',
        created.id,
        { expectedVersion: 1, reason: 'Wrong tenant attempt' },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        'grant',
        created.id,
        { expectedVersion: 2, reason: 'Stale operator view' },
      ),
    ).rejects.toThrow('STALE_VERSION');
    const revoked = await revokeEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      'grant',
      created.id,
      { expectedVersion: 1, reason: 'Seasonal approval withdrawn' },
    );
    expect(revoked).toEqual({
      id: created.id,
      version: 2,
      entitlementVersion: 3,
    });
    expect(
      await admin.entitlementGrant.findUnique({ where: { id: created.id } }),
    ).toMatchObject({
      status: 'revoked',
      version: 2,
      revokedReason: 'Seasonal approval withdrawn',
    });
    expect(
      await admin.auditEvent.findMany({
        where: { tenantId, resourceId: created.id },
        orderBy: { createdAt: 'asc' },
        select: { action: true, reason: true },
      }),
    ).toEqual([
      {
        action: 'entitlement.change_created',
        reason: 'Approved seasonal capacity',
      },
      {
        action: 'entitlement.change_revoked',
        reason: 'Seasonal approval withdrawn',
      },
    ]);
  });
});
