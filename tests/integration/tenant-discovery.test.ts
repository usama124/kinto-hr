import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, discoverIdentityTenants } from '@kinto/database';

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
  throw new Error('Tenant discovery tests require kinto_test databases');

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let identityId: string;
let otherIdentityId: string;
let tenantIds: string[];

describe('tenant discovery boundary', () => {
  beforeEach(async () => {
    identityId = randomUUID();
    otherIdentityId = randomUUID();
    tenantIds = [randomUUID(), randomUUID(), randomUUID()];
    await admin.identity.createMany({
      data: [identityId, otherIdentityId].map((id) => ({
        id,
        issuer: 'https://tenant-discovery.synthetic.example/realms/kinto',
        subject: randomUUID(),
      })),
    });
    await admin.tenant.createMany({
      data: [
        { id: tenantIds[0], name: 'Zulu Company', employeeLimit: 5 },
        { id: tenantIds[1], name: 'Alpha Company', employeeLimit: 20 },
        {
          id: tenantIds[2],
          name: 'Suspended Company',
          employeeLimit: 20,
          status: 'suspended',
        },
      ],
    });
    await admin.membership.createMany({
      data: [
        {
          tenantId: tenantIds[0],
          identityId,
          roles: ['owner', 'payroll_approver'],
        },
        {
          tenantId: tenantIds[1],
          identityId,
          roles: ['hr_admin'],
          status: 'revoked',
        },
        {
          tenantId: tenantIds[2],
          identityId,
          roles: ['employee'],
        },
        {
          tenantId: tenantIds[1],
          identityId: otherIdentityId,
          roles: ['owner'],
        },
      ],
    });
  });

  afterEach(async () => {
    await admin.membership.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await admin.identity.deleteMany({
      where: { id: { in: [identityId, otherIdentityId] } },
    });
  });

  afterAll(async () => {
    await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  });

  it('returns only active tenant access with a safe stable projection', async () => {
    expect(await discoverIdentityTenants(runtime, identityId)).toEqual([
      {
        id: tenantIds[0],
        name: 'Zulu Company',
        membershipId: expect.any(String),
        roles: ['owner', 'payroll_approver'],
      },
    ]);
    expect(await runtime.membership.findMany()).toEqual([]);
  });

  it('returns no access for a disabled identity', async () => {
    await admin.identity.update({
      where: { id: identityId },
      data: { status: 'disabled' },
    });
    expect(await discoverIdentityTenants(runtime, identityId)).toEqual([]);
  });

  it('uses the constrained non-login control owner', async () => {
    const functions = await admin.$queryRaw<
      { owner: string; login: boolean; bypass: boolean; executable: boolean }[]
    >`SELECT r.rolname AS owner, r.rolcanlogin AS login,
      r.rolbypassrls AS bypass,
      has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS executable
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'discover_identity_tenants'`;
    expect(functions).toEqual([
      {
        owner: 'kinto_control_owner',
        login: false,
        bypass: false,
        executable: true,
      },
    ]);
  });
});
