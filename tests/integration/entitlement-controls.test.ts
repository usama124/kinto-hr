import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readAttendanceAllocation,
  changeAttendanceAllocation,
  inTenant,
  activateEmployee,
  createDatabase,
  createEntitlementChange,
  previewEntitlementChange,
  readTenantEntitlements,
  revokeEntitlementChange,
  readPlatformEntitlementState,
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
    await admin.attendanceAllocation.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
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

  it('atomically reconciles concurrent exact retries without duplicated controls, audits or versions', async () => {
    const input = {
      changeType: 'capacity_addon' as const,
      seatDelta: 5,
      ...interval(),
      reason: 'Synthetic retry receipt',
    };
    const requestId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        createEntitlementChange(
          runtime,
          actor(operatorId),
          tenantId,
          input,
          requestId,
        ),
      ),
    );
    expect(
      results.every(
        (result) => JSON.stringify(result) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    const state = await readPlatformEntitlementState(
      runtime,
      actor(operatorId),
      tenantId,
    );
    expect(state.controls).toHaveLength(1);
    expect(state.effective.employeeLimit).toBe(10);
    expect(state.effective.entitlementVersion).toBe(2);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'entitlement.change_created' },
      }),
    ).toBe(1);
    expect(
      await admin.platformAuditEvent.count({
        where: { actorId: operatorId, action: 'entitlement.change_created' },
      }),
    ).toBe(1);
    await expect(
      createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        { ...input, seatDelta: 6 },
        requestId,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      createEntitlementChange(
        runtime,
        actor(operatorId, false),
        tenantId,
        input,
        requestId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createEntitlementChange(
        runtime,
        actor(ownerId),
        tenantId,
        input,
        requestId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await revokeEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      'grant',
      results[0]!.id,
      { expectedVersion: 1, reason: 'Synthetic revoke after creation' },
      randomUUID(),
    );
    expect(
      await createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        input,
        requestId,
      ),
    ).toEqual(results[0]);
    expect(
      (await readPlatformEntitlementState(runtime, actor(operatorId), tenantId))
        .effective.employeeLimit,
    ).toBe(5);
    await expect(
      runtime.$queryRaw`SELECT * FROM public.entitlement_creation_receipts`,
    ).rejects.toThrow();
    await expect(
      runtime.$queryRaw`SELECT * FROM public.create_entitlement_change(${operatorId}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,'capacity_addon'::varchar,now(),now()+interval '1 day',NULL::integer,5,'Bypass attempt'::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow();
  });

  it('scopes receipts by company, rejects changed fields and does not reserve refused requests', async () => {
    const requestId = randomUUID();
    const input = {
      changeType: 'complimentary' as const,
      employeeLimit: 20 as const,
      ...interval(),
      reason: 'Scoped complimentary receipt',
    };
    const result = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
      requestId,
    );
    const other = await createEntitlementChange(
      runtime,
      actor(operatorId),
      otherTenantId,
      input,
      requestId,
    );
    expect(other.id).not.toBe(result.id);
    for (const changed of [
      { ...input, reason: 'Different reason' },
      { ...input, employeeLimit: 50 as const },
      { ...input, endsAt: new Date(Date.now() + 172800000).toISOString() },
    ]) {
      await expect(
        createEntitlementChange(
          runtime,
          actor(operatorId),
          tenantId,
          changed,
          requestId,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    const key = randomUUID();
    const expired = {
      ...input,
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: '2020-02-01T00:00:00Z',
    };
    await expect(
      createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        expired,
        key,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const override = {
      changeType: 'employee_limit_override' as const,
      employeeLimit: 10,
      ...interval(),
      reason: 'Scoped override receipt',
    };
    const control = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      override,
      key,
    );
    expect(
      await createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        override,
        key,
      ),
    ).toEqual(control);
    await admin.platformOperator.update({
      where: { identityId: operatorId },
      data: { status: 'revoked' },
    });
    await expect(
      createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        input,
        requestId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    'capacity_addon',
    'complimentary',
    'employee_limit_override',
  ] as const)(
    'reconciles concurrent %s revocations with one immutable receipt and audit pair',
    async (changeType) => {
      const dates = interval();
      const input =
        changeType === 'capacity_addon'
          ? {
              changeType,
              seatDelta: 5,
              ...dates,
              reason: 'Synthetic revocation target',
            }
          : changeType === 'complimentary'
            ? {
                changeType,
                employeeLimit: 20 as const,
                ...dates,
                reason: 'Synthetic revocation target',
              }
            : {
                changeType,
                employeeLimit: 10,
                ...dates,
                reason: 'Synthetic revocation target',
              };
      const target = await createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        input,
        randomUUID(),
      );
      const kind =
        changeType === 'employee_limit_override' ? 'override' : 'grant';
      const requestId = randomUUID();
      const revocation = {
        expectedVersion: 1,
        reason: 'Synthetic exact revocation',
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          revokeEntitlementChange(
            runtime,
            actor(operatorId),
            tenantId,
            kind,
            target.id,
            revocation,
            requestId,
          ),
        ),
      );
      expect(
        results.every(
          (result) => JSON.stringify(result) === JSON.stringify(results[0]),
        ),
      ).toBe(true);
      expect(results[0]).toEqual({
        id: target.id,
        version: 2,
        entitlementVersion: 3,
      });
      const state = await readPlatformEntitlementState(
        runtime,
        actor(operatorId),
        tenantId,
      );
      expect(state.controls).toHaveLength(1);
      expect(state.controls[0]).toMatchObject({
        status: 'revoked',
        version: 2,
        revokedReason: revocation.reason,
      });
      expect(state.effective.employeeLimit).toBe(5);
      expect(
        await admin.auditEvent.count({
          where: { tenantId, action: 'entitlement.change_revoked' },
        }),
      ).toBe(1);
      expect(
        await admin.platformAuditEvent.count({
          where: { actorId: operatorId, action: 'entitlement.change_revoked' },
        }),
      ).toBe(1);
      for (const changed of [
        { ...revocation, reason: 'Changed reason' },
        { ...revocation, expectedVersion: 2 },
      ]) {
        await expect(
          revokeEntitlementChange(
            runtime,
            actor(operatorId),
            tenantId,
            kind,
            target.id,
            changed,
            requestId,
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
      }
      await expect(
        revokeEntitlementChange(
          runtime,
          actor(operatorId),
          tenantId,
          kind,
          randomUUID(),
          revocation,
          requestId,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        revokeEntitlementChange(
          runtime,
          actor(operatorId),
          tenantId,
          kind === 'grant' ? 'override' : 'grant',
          target.id,
          revocation,
          requestId,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        revokeEntitlementChange(
          runtime,
          actor(operatorId),
          tenantId,
          kind,
          target.id,
          revocation,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'STALE_VERSION' });
      await createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        {
          changeType: 'capacity_addon',
          seatDelta: 3,
          ...interval(),
          reason: 'Later independent control',
        },
        randomUUID(),
      );
      expect(
        await revokeEntitlementChange(
          runtime,
          actor(operatorId),
          tenantId,
          kind,
          target.id,
          revocation,
          requestId,
        ),
      ).toEqual(results[0]);
      expect(
        (
          await readPlatformEntitlementState(
            runtime,
            actor(operatorId),
            tenantId,
          )
        ).effective,
      ).toMatchObject({ employeeLimit: 8, entitlementVersion: 4 });
    },
  );

  it('scopes revocation receipts by company and actor, and rechecks authority on replay', async () => {
    const input = {
      changeType: 'capacity_addon' as const,
      seatDelta: 5,
      ...interval(),
      reason: 'Scoped revocation target',
    };
    const first = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
      randomUUID(),
    );
    const second = await createEntitlementChange(
      runtime,
      actor(operatorId),
      otherTenantId,
      input,
      randomUUID(),
    );
    const key = randomUUID();
    const body = { expectedVersion: 1, reason: 'Scoped revocation reason' };
    await revokeEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      'grant',
      first.id,
      body,
      key,
    );
    expect(
      (
        await revokeEntitlementChange(
          runtime,
          actor(operatorId),
          otherTenantId,
          'grant',
          second.id,
          body,
          key,
        )
      ).id,
    ).toBe(second.id);
    await admin.platformOperator.create({
      data: { identityId: nonOperatorId },
    });
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(nonOperatorId),
        tenantId,
        'grant',
        first.id,
        body,
        key,
      ),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(ownerId),
        tenantId,
        'grant',
        first.id,
        body,
        key,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId, false),
        tenantId,
        'grant',
        first.id,
        body,
        key,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        'grant',
        first.id,
        body,
        key,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'active' },
    });
    await admin.platformOperator.update({
      where: { identityId: operatorId },
      data: { status: 'revoked' },
    });
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        'grant',
        first.id,
        body,
        key,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      runtime.$queryRaw`SELECT * FROM public.entitlement_revocation_receipts`,
    ).rejects.toThrow();
    await expect(
      runtime.$queryRaw`SELECT * FROM public.revoke_entitlement_change(${operatorId}::uuid,true,${tenantId}::uuid,'grant'::varchar,${first.id}::uuid,1,'Bypass revocation'::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow();
  });

  it('rolls back revocation with audit failure and does not reserve refused request keys', async () => {
    const target = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      {
        changeType: 'capacity_addon',
        seatDelta: 5,
        ...interval(),
        reason: 'Atomic revocation target',
      },
      randomUUID(),
    );
    const body = { expectedVersion: 1, reason: 'Atomic revocation reason' };
    const key = randomUUID();
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        'grant',
        target.id,
        { ...body, expectedVersion: 2 },
        key,
      ),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        'grant',
        randomUUID(),
        body,
        key,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const priorAudit = await admin.auditEvent.findFirstOrThrow({
      where: { tenantId, action: 'entitlement.change_created' },
    });
    await expect(
      runtime.$queryRaw`SELECT * FROM public.revoke_entitlement_change_idempotent(${operatorId}::uuid,true,${tenantId}::uuid,${key}::uuid,'grant'::varchar,${target.id}::uuid,1,${body.reason}::varchar,${priorAudit.id}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow();
    const state = await readPlatformEntitlementState(
      runtime,
      actor(operatorId),
      tenantId,
    );
    expect(state.controls[0]).toMatchObject({ status: 'active', version: 1 });
    expect(state.effective.entitlementVersion).toBe(2);
    expect(
      await admin.entitlementRevocationReceipt.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'entitlement.change_revoked' },
      }),
    ).toBe(0);
    expect(
      await revokeEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        'grant',
        target.id,
        body,
        key,
      ),
    ).toEqual({ id: target.id, version: 2, entitlementVersion: 3 });
  });

  it('projects operator-only effective state and control history without identity fields', async () => {
    const change = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      {
        changeType: 'capacity_addon',
        seatDelta: 5,
        ...interval(),
        reason: 'Synthetic capacity grant',
      },
      randomUUID(),
    );
    const result = await readPlatformEntitlementState(
      runtime,
      actor(operatorId),
      tenantId,
    );
    expect(result).toMatchObject({
      tenantId,
      historyTruncated: false,
      effective: { employeeLimit: 10 },
      controls: [
        {
          id: change.id,
          kind: 'grant',
          version: 1,
          reason: 'Synthetic capacity grant',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(operatorId);
    expect(
      (
        await readPlatformEntitlementState(
          runtime,
          actor(operatorId),
          otherTenantId,
        )
      ).controls,
    ).toEqual([]);
    for (const denied of [
      actor(ownerId),
      actor(nonOperatorId),
      actor(operatorId, false),
    ])
      await expect(
        readPlatformEntitlementState(runtime, denied, tenantId),
      ).rejects.toThrow('FORBIDDEN');
    await revokeEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      'grant',
      change.id,
      { expectedVersion: 1, reason: 'Synthetic grant cancellation' },
      randomUUID(),
    );
    expect(
      (await readPlatformEntitlementState(runtime, actor(operatorId), tenantId))
        .controls[0],
    ).toMatchObject({
      status: 'revoked',
      version: 2,
      revokedReason: 'Synthetic grant cancellation',
    });
  });

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
      randomUUID(),
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
    await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
      randomUUID(),
    );
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
    await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      addon,
      randomUUID(),
    );
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
      randomUUID(),
    );
    expect(created.entitlementVersion).toBe(3);
    expect(
      await readTenantEntitlements(runtime, actor(ownerId), tenantId),
    ).toMatchObject({ employeeLimit: 3, entitlementVersion: 3 });
    await expect(
      createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        override,
        randomUUID(),
      ),
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
        createEntitlementChange(runtime, caller, tenantId, input, randomUUID()),
      ).rejects.toThrow('FORBIDDEN');
    await admin.platformOperator.update({
      where: { identityId: operatorId },
      data: { status: 'revoked' },
    });
    await expect(
      createEntitlementChange(
        runtime,
        actor(operatorId),
        tenantId,
        input,
        randomUUID(),
      ),
    ).rejects.toThrow('FORBIDDEN');
    await admin.platformOperator.delete({ where: { identityId: operatorId } });
    await admin.platformOperator.create({ data: { identityId: operatorId } });
    const created = await createEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      input,
      randomUUID(),
    );
    await expect(
      revokeEntitlementChange(
        runtime,
        actor(operatorId),
        otherTenantId,
        'grant',
        created.id,
        { expectedVersion: 1, reason: 'Wrong tenant attempt' },
        randomUUID(),
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
        randomUUID(),
      ),
    ).rejects.toThrow('STALE_VERSION');
    const revoked = await revokeEntitlementChange(
      runtime,
      actor(operatorId),
      tenantId,
      'grant',
      created.id,
      { expectedVersion: 1, reason: 'Seasonal approval withdrawn' },
      randomUUID(),
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
  const allocation = {
    expectedVersion: 0,
    enabled: true,
    deviceLimit: 2,
    connectorLimit: 1,
    reason: 'initial_setup' as const,
  };

  it('defaults every company to no attendance allocation without changing employee or billing entitlements', async () => {
    const subscription = await admin.tenantSubscription.findFirstOrThrow({
      where: { tenantId },
    });
    for (const code of ['free', 'starter', 'growth', 'business', 'scale']) {
      const plan = await admin.planVersion.findFirstOrThrow({
        where: { code, planVersion: 1 },
      });
      await admin.tenantSubscription.update({
        where: { id: subscription.id },
        data: {
          planVersionId: plan.id,
          employeeLimit: plan.employeeLimit,
          billingMode: code === 'free' ? 'free' : 'manual_paid',
        },
      });
      expect(
        await readAttendanceAllocation(runtime, actor(ownerId), tenantId),
      ).toMatchObject({
        version: 0,
        enabled: false,
        deviceLimit: 0,
        connectorLimit: 0,
      });
    }
    await admin.tenantSubscription.update({
      where: { id: subscription.id },
      data: { billingMode: 'complimentary' },
    });
    expect(
      (await readAttendanceAllocation(runtime, actor(ownerId), tenantId))
        .enabled,
    ).toBe(false);
    const before = await readTenantEntitlements(
      runtime,
      actor(ownerId),
      tenantId,
    );
    const initial = await readAttendanceAllocation(
      runtime,
      actor(ownerId),
      tenantId,
    );
    expect(initial).toEqual({
      tenantId,
      version: 0,
      enabled: false,
      deviceLimit: 0,
      connectorLimit: 0,
      configuredAt: null,
      machineAccessAvailable: false,
    });
    const changed = await changeAttendanceAllocation(
      runtime,
      actor(operatorId),
      tenantId,
      randomUUID(),
      allocation,
    );
    expect(changed).toMatchObject({ version: 1, replayed: false });
    expect(
      await readAttendanceAllocation(
        runtime,
        actor(operatorId),
        tenantId,
        true,
      ),
    ).toMatchObject({
      version: 1,
      enabled: true,
      deviceLimit: 2,
      connectorLimit: 1,
      machineAccessAvailable: false,
    });
    expect(
      await readTenantEntitlements(runtime, actor(ownerId), tenantId),
    ).toEqual(before);
    expect(
      await readAttendanceAllocation(
        runtime,
        actor(operatorId),
        otherTenantId,
        true,
      ),
    ).toMatchObject({ version: 0, enabled: false });
  });

  it('keeps allocations append-only and denies tenant-context runtime access', async () => {
    await changeAttendanceAllocation(
      runtime,
      actor(operatorId),
      tenantId,
      randomUUID(),
      allocation,
    );
    for (const sql of [
      'SELECT * FROM attendance_allocations',
      'INSERT INTO attendance_allocations(id) VALUES(gen_random_uuid())',
      'UPDATE attendance_allocations SET enabled=false',
      'DELETE FROM attendance_allocations',
    ])
      await expect(
        inTenant(runtime, tenantId, (tx) => tx.$queryRawUnsafe(sql)),
      ).rejects.toThrow();
    const grants = await admin.$queryRaw<
      { privilege_type: string }[]
    >`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='attendance_allocations' AND grantee='kinto_control_owner' ORDER BY privilege_type`;
    expect(grants.map((row) => row.privilege_type)).toEqual([
      'INSERT',
      'SELECT',
    ]);
    for (const key of ['WORKER_DATABASE_URL', 'DISPATCHER_DATABASE_URL']) {
      const db = createDatabase(process.env[key]!);
      try {
        await expect(
          db.$queryRaw`SELECT * FROM attendance_allocations`,
        ).rejects.toThrow();
        await expect(
          db.$queryRaw`SELECT * FROM read_attendance_allocation(${ownerId}::uuid,true,${tenantId}::uuid,false)`,
        ).rejects.toThrow();
      } finally {
        await db.$disconnect();
      }
    }
    for (const caller of [
      actor(ownerId),
      actor(nonOperatorId),
      actor(operatorId, false),
    ])
      await expect(
        changeAttendanceAllocation(
          runtime,
          caller,
          tenantId,
          randomUUID(),
          allocation,
        ),
      ).rejects.toThrow('FORBIDDEN');
    await expect(
      readAttendanceAllocation(runtime, actor(ownerId), tenantId, true),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readAttendanceAllocation(runtime, actor(ownerId), otherTenantId),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readAttendanceAllocation(runtime, actor(ownerId, false), tenantId),
    ).rejects.toThrow('FORBIDDEN');
    await admin.membership.update({
      where: { tenantId_identityId: { tenantId, identityId: ownerId } },
      data: { roles: ['hr_admin'] },
    });
    expect(
      (await readAttendanceAllocation(runtime, actor(ownerId), tenantId))
        .enabled,
    ).toBe(true);
    await admin.membership.update({
      where: { tenantId_identityId: { tenantId, identityId: ownerId } },
      data: { status: 'revoked' },
    });
    await expect(
      readAttendanceAllocation(runtime, actor(ownerId), tenantId),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('reconciles concurrent allocation retries once and rejects altered request reuse', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        changeAttendanceAllocation(
          runtime,
          actor(operatorId),
          tenantId,
          key,
          allocation,
        ),
      ),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(results.filter((row) => !row.replayed)).toHaveLength(1);
    expect(
      await admin.attendanceAllocation.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'attendance.allocation_changed' },
      }),
    ).toBe(1);
    expect(
      await admin.platformAuditEvent.count({
        where: { actorId: operatorId, action: 'attendance.allocation_changed' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'attendance.allocation_changed.v1' },
      }),
    ).toBe(1);
    await expect(
      changeAttendanceAllocation(runtime, actor(operatorId), tenantId, key, {
        ...allocation,
        deviceLimit: 3,
      }),
    ).rejects.toThrow('CONFLICT');
    await admin.platformOperator.update({
      where: { identityId: operatorId },
      data: { status: 'revoked' },
    });
    await expect(
      changeAttendanceAllocation(
        runtime,
        actor(operatorId),
        tenantId,
        key,
        allocation,
      ),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('rejects stale concurrent changes, preserves versions and disables without erasing history', async () => {
    const key = randomUUID();
    const first = await changeAttendanceAllocation(
      runtime,
      actor(operatorId),
      tenantId,
      key,
      allocation,
    );
    const changes = await Promise.allSettled(
      [3, 4].map((deviceLimit) =>
        changeAttendanceAllocation(
          runtime,
          actor(operatorId),
          tenantId,
          randomUUID(),
          {
            ...allocation,
            expectedVersion: 1,
            deviceLimit,
            reason: 'allocation_change',
          },
        ),
      ),
    );
    expect(changes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(changes.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const disabled = await changeAttendanceAllocation(
      runtime,
      actor(operatorId),
      tenantId,
      randomUUID(),
      {
        expectedVersion: 2,
        enabled: false,
        deviceLimit: 0,
        connectorLimit: 0,
        reason: 'disable_attendance',
      },
    );
    expect(disabled.version).toBe(3);
    expect(
      await readAttendanceAllocation(runtime, actor(ownerId), tenantId),
    ).toMatchObject({
      enabled: false,
      deviceLimit: 0,
      connectorLimit: 0,
      version: 3,
      machineAccessAvailable: false,
    });
    expect(
      await changeAttendanceAllocation(
        runtime,
        actor(operatorId),
        tenantId,
        key,
        allocation,
      ),
    ).toEqual({ ...first, replayed: true });
    expect(
      await admin.attendanceAllocation.count({ where: { tenantId } }),
    ).toBe(3);
    await expect(
      changeAttendanceAllocation(
        runtime,
        actor(operatorId),
        tenantId,
        randomUUID(),
        {
          expectedVersion: 3,
          enabled: false,
          deviceLimit: 0,
          connectorLimit: 0,
          reason: 'disable_attendance',
        },
      ),
    ).rejects.toThrow('CONFLICT');
  });

  it('fails closed for suspended companies and invalid direct allocation commands', async () => {
    const direct = (
      enabled: boolean,
      devices: number,
      connectors: number,
      reason: string,
    ) => runtime.$queryRaw`SELECT * FROM change_attendance_allocation(
      ${operatorId}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,0,
      ${enabled},${devices}::integer,${connectors}::integer,${reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
    for (const [enabled, devices, connectors, reason] of [
      [true, 0, 1, 'initial_setup'],
      [true, 1001, 1, 'initial_setup'],
      [false, 0, 0, 'disable_attendance'],
      [true, 1, 1, 'private reason'],
    ] as const)
      expect(await direct(enabled, devices, connectors, reason)).toEqual([
        { outcome: 'invalid_state', record_id: null, record_version: null },
      ]);
    expect(
      await admin.attendanceAllocation.count({ where: { tenantId } }),
    ).toBe(0);
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended' },
    });
    await expect(
      changeAttendanceAllocation(
        runtime,
        actor(operatorId),
        tenantId,
        randomUUID(),
        allocation,
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      readAttendanceAllocation(runtime, actor(operatorId), tenantId, true),
    ).rejects.toThrow('NOT_FOUND');
  });
});
