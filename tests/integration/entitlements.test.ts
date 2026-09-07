import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateEmployee,
  createDatabase,
  readTenantEntitlements,
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
let hrId: string;
let employeeIdentityId: string;
let otherOwnerId: string;

const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});

describe('immutable plan and base subscription entitlement boundary', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    hrId = randomUUID();
    employeeIdentityId = randomUUID();
    otherOwnerId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic entitlement company',
        employeeLimit: 250,
        billingMode: 'complimentary',
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, hrId, employeeIdentityId, otherOwnerId].map((id) => ({
        id,
        issuer: 'https://entitlements.synthetic.example/realm',
        subject: randomUUID(),
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        { tenantId, identityId: hrId, roles: ['hr_admin'] },
        { tenantId, identityId: employeeIdentityId, roles: ['employee'] },
        { tenantId: otherTenantId, identityId: otherOwnerId, roles: ['owner'] },
      ],
    });
    const free = await admin.planVersion.findFirstOrThrow({
      where: { code: 'free', planVersion: 1 },
    });
    await admin.tenantSubscription.create({
      data: {
        id: randomUUID(),
        tenantId,
        subscriptionVersion: 1,
        planVersionId: free.id,
        billingMode: 'complimentary',
        employeeLimit: 5,
        reason: 'Synthetic complimentary subscription',
      },
    });
  });

  afterEach(async () => {
    const tenantIds = [tenantId, otherTenantId];
    await admin.consumerReceipt.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.jobDelivery.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.outboxEvent.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.employee.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await admin.membership.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await admin.identity.deleteMany({
      where: { id: { in: [ownerId, hrId, employeeIdentityId, otherOwnerId] } },
    });
  });

  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('seeds five price-free immutable plan versions and denies direct runtime catalog access', async () => {
    expect(
      await admin.planVersion.findMany({
        orderBy: { employeeLimit: 'asc' },
        select: {
          code: true,
          planVersion: true,
          employeeLimit: true,
          capabilities: true,
        },
      }),
    ).toEqual([
      {
        code: 'free',
        planVersion: 1,
        employeeLimit: 5,
        capabilities: { companySetup: true },
      },
      {
        code: 'starter',
        planVersion: 1,
        employeeLimit: 20,
        capabilities: { companySetup: true },
      },
      {
        code: 'growth',
        planVersion: 1,
        employeeLimit: 50,
        capabilities: { companySetup: true },
      },
      {
        code: 'business',
        planVersion: 1,
        employeeLimit: 100,
        capabilities: { companySetup: true },
      },
      {
        code: 'scale',
        planVersion: 1,
        employeeLimit: 250,
        capabilities: { companySetup: true },
      },
    ]);
    const free = await admin.planVersion.findFirstOrThrow({
      where: { code: 'free' },
    });
    await expect(
      admin.planVersion.update({
        where: { id: free.id },
        data: { employeeLimit: 20 },
      }),
    ).rejects.toThrow();
    await expect(
      admin.planVersion.delete({ where: { id: free.id } }),
    ).rejects.toThrow();
    await expect(runtime.planVersion.findMany()).rejects.toThrow();
  });

  it('returns the effective base subscription only to recent-MFA owners and HR', async () => {
    const [functionAccess] = await admin.$queryRaw<
      {
        owner: string;
        login: boolean;
        bypass: boolean;
        appCanExecute: boolean;
      }[]
    >`SELECT r.rolname AS owner, r.rolcanlogin AS login,
      r.rolbypassrls AS bypass,
      has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS "appCanExecute"
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'read_tenant_entitlements'`;
    expect(functionAccess).toEqual({
      owner: 'kinto_control_owner',
      login: false,
      bypass: false,
      appCanExecute: true,
    });
    await admin.employee.createMany({
      data: [1, 2].map((number) => ({
        tenantId,
        employeeNumber: `ACTIVE-${number}`,
        name: `Synthetic employee ${number}`,
        status: 'active',
      })),
    });
    const expected = {
      plan: { code: 'free', version: 1 },
      billingMode: 'complimentary',
      employeeLimit: 5,
      activeEmployees: 2,
      availableEmployeeSeats: 3,
      capabilities: { companySetup: true },
      entitlementVersion: 1,
    };
    expect(
      await readTenantEntitlements(runtime, actor(ownerId), tenantId),
    ).toMatchObject(expected);
    expect(
      await readTenantEntitlements(runtime, actor(hrId), tenantId),
    ).toMatchObject(expected);
    for (const caller of [
      actor(employeeIdentityId),
      actor(ownerId, false),
      actor(otherOwnerId),
    ])
      await expect(
        readTenantEntitlements(runtime, caller, tenantId),
      ).rejects.toThrow('FORBIDDEN');
  });

  it('uses subscribed capacity instead of the legacy tenant column and serializes the final seat', async () => {
    await admin.employee.createMany({
      data: [1, 2, 3, 4].map((number) => ({
        tenantId,
        employeeNumber: `ACTIVE-${number}`,
        name: `Synthetic active ${number}`,
        status: 'active',
      })),
    });
    const drafts = await Promise.all(
      [1, 2].map((number) =>
        admin.employee.create({
          data: {
            tenantId,
            employeeNumber: `DRAFT-${number}`,
            name: `Synthetic draft ${number}`,
          },
        }),
      ),
    );
    const results = await Promise.allSettled(
      drafts.map((employee) =>
        activateEmployee(runtime, tenantId, employee.id, 1, ownerId),
      ),
    );
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await admin.employee.count({ where: { tenantId, status: 'active' } }),
    ).toBe(5);
  });
});
