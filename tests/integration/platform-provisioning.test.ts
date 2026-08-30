import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, requestCompanyProvisioning } from '@kinto/database';

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
  throw new Error('Platform provisioning tests require kinto_test* databases');

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const issuer = 'https://platform.synthetic.example/realm';
const input = {
  companyName: 'Synthetic Provisioned Company',
  employeeLimit: 20,
  billingMode: 'complimentary' as const,
  initialOwnerEmail: 'owner@synthetic.example',
};
let operatorId: string;
let ordinaryIdentityId: string;
const tenantIds: string[] = [];

describe('platform-only company provisioning boundary', () => {
  beforeAll(async () => {
    operatorId = (
      await admin.identity.create({
        data: { issuer, subject: randomUUID() },
      })
    ).id;
    ordinaryIdentityId = (
      await admin.identity.create({
        data: { issuer, subject: randomUUID() },
      })
    ).id;
    await admin.platformOperator.create({ data: { identityId: operatorId } });
  });

  afterAll(async () => {
    await admin.platformAuditEvent.deleteMany({
      where: { actorId: operatorId },
    });
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.companyProvisioningRequest.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await admin.platformOperator.deleteMany({
      where: { identityId: operatorId },
    });
    await admin.identity.deleteMany({
      where: { id: { in: [operatorId, ordinaryIdentityId] } },
    });
    await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  });

  it('denies ordinary identities, missing MFA, and all direct runtime writes', async () => {
    for (const actor of [
      { identityId: ordinaryIdentityId, mfaVerified: true },
      { identityId: operatorId, mfaVerified: false },
    ])
      await expect(
        requestCompanyProvisioning(runtime, actor, randomUUID(), input),
      ).rejects.toThrow('FORBIDDEN');
    expect(
      await admin.companyProvisioningRequest.count({
        where: {
          requestedByIdentityId: {
            in: [operatorId, ordinaryIdentityId],
          },
        },
      }),
    ).toBe(0);
    await expect(runtime.platformOperator.findMany()).rejects.toThrow();
    await expect(
      runtime.companyProvisioningRequest.findMany(),
    ).rejects.toThrow();
    await expect(
      runtime.tenant.create({ data: { name: 'Forged', employeeLimit: 250 } }),
    ).rejects.toThrow();
    await expect(
      runtime.platformOperator.create({
        data: { identityId: ordinaryIdentityId },
      }),
    ).rejects.toThrow();
  });

  it('atomically creates one denied-until-provider request and both audit records', async () => {
    const key = randomUUID();
    const result = await requestCompanyProvisioning(
      runtime,
      { identityId: operatorId, mfaVerified: true },
      key,
      input,
    );
    tenantIds.push(result.tenantId);
    expect(result).toMatchObject({
      status: 'pending_identity_provider',
      replayed: false,
    });
    const request = await admin.companyProvisioningRequest.findUniqueOrThrow({
      where: { id: result.provisioningRequestId },
    });
    expect(request).toMatchObject({
      tenantId: result.tenantId,
      requestedByIdentityId: operatorId,
      initialOwnerEmail: input.initialOwnerEmail,
      status: 'pending_identity_provider',
    });
    expect(
      await admin.membership.count({ where: { tenantId: result.tenantId } }),
    ).toBe(0);
    expect(
      await admin.auditEvent.count({ where: { tenantId: result.tenantId } }),
    ).toBe(1);
    expect(
      await admin.platformAuditEvent.count({
        where: { resourceId: result.tenantId },
      }),
    ).toBe(1);
  });

  it('serializes concurrent retries and rejects key reuse with changed input', async () => {
    const key = randomUUID();
    const call = () =>
      requestCompanyProvisioning(
        runtime,
        { identityId: operatorId, mfaVerified: true },
        key,
        input,
      );
    const [first, second] = await Promise.all([call(), call()]);
    tenantIds.push(first.tenantId);
    expect(first.tenantId).toBe(second.tenantId);
    expect(first.provisioningRequestId).toBe(second.provisioningRequestId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(
      await admin.companyProvisioningRequest.count({
        where: { requestedByIdentityId: operatorId, requestKey: key },
      }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({ where: { tenantId: first.tenantId } }),
    ).toBe(1);
    await expect(
      requestCompanyProvisioning(
        runtime,
        { identityId: operatorId, mfaVerified: true },
        key,
        { ...input, employeeLimit: 50 },
      ),
    ).rejects.toThrow('CONFLICT');
  });

  it('uses a constrained non-login function owner and grants only execution to the API role', async () => {
    const [owner] = await admin.$queryRaw<
      {
        owner: string;
        login: boolean;
        bypass: boolean;
        app_can_execute: boolean;
      }[]
    >`SELECT r.rolname AS owner, r.rolcanlogin AS login, r.rolbypassrls AS bypass,
      has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS app_can_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'request_company_provisioning'`;
    expect(owner).toEqual({
      owner: 'kinto_control_owner',
      login: false,
      bypass: false,
      app_can_execute: true,
    });
  });
});
