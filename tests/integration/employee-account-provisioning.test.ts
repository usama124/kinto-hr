import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  requestEmployeeAccountProvisioning,
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
  throw new Error(
    'Employee account tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const tenantA = randomUUID();
const tenantB = randomUUID();
const identityIds = {
  owner: randomUUID(),
  hr: randomUUID(),
  employee: randomUUID(),
  otherOwner: randomUUID(),
};
const employeeIds = {
  hrRequest: randomUUID(),
  ownerRequest: randomUUID(),
  concurrent: randomUUID(),
  unused: randomUUID(),
  terminated: randomUUID(),
  otherTenant: randomUUID(),
};

describe('employee account provisioning request boundary', () => {
  beforeAll(async () => {
    await admin.tenant.createMany({
      data: [tenantA, tenantB].map((id) => ({
        id,
        name: 'Synthetic employee account tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: Object.entries(identityIds).map(([name, id]) => ({
        id,
        issuer: 'https://employee-accounts.synthetic.example/realm',
        subject: `${name}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId: tenantA, identityId: identityIds.owner, roles: ['owner'] },
        { tenantId: tenantA, identityId: identityIds.hr, roles: ['hr_admin'] },
        {
          tenantId: tenantA,
          identityId: identityIds.employee,
          roles: ['employee'],
        },
        {
          tenantId: tenantB,
          identityId: identityIds.otherOwner,
          roles: ['owner'],
        },
      ],
    });
    await admin.employee.createMany({
      data: [
        ...Object.entries(employeeIds)
          .filter(([name]) => name !== 'otherTenant')
          .map(([name, id]) => ({
            id,
            tenantId: tenantA,
            employeeNumber: name,
            name: `Synthetic ${name}`,
            ...(name === 'terminated' ? { status: 'terminated' } : {}),
          })),
        {
          id: employeeIds.otherTenant,
          tenantId: tenantB,
          employeeNumber: 'other-tenant',
          name: 'Synthetic other tenant employee',
        },
      ],
    });
  });

  afterAll(async () => {
    await admin.employeeAccountRequest.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await admin.membership.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await admin.employee.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await admin.identity.deleteMany({
      where: { id: { in: Object.values(identityIds) } },
    });
    await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  });

  it('allows an MFA-verified HR user and records no identity or membership', async () => {
    const identityCount = await admin.identity.count();
    const membershipCount = await admin.membership.count();
    const key = randomUUID();
    const created = await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.hr, mfaVerified: true },
      tenantA,
      employeeIds.hrRequest,
      key,
      { email: ' Staff@Example.COM ' },
    );
    expect(created).toMatchObject({
      status: 'pending_identity_provider',
      replayed: false,
    });
    expect(
      await requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.hr, mfaVerified: true },
        tenantA,
        employeeIds.hrRequest,
        key,
        { email: 'staff@example.com' },
      ),
    ).toEqual({ ...created, replayed: true });
    expect(
      await admin.employeeAccountRequest.findUniqueOrThrow({
        where: { id: created.accountRequestId },
      }),
    ).toMatchObject({
      tenantId: tenantA,
      employeeId: employeeIds.hrRequest,
      requestedByIdentityId: identityIds.hr,
      email: 'staff@example.com',
    });
    expect(await admin.identity.count()).toBe(identityCount);
    expect(await admin.membership.count()).toBe(membershipCount);
    expect(
      await admin.auditEvent.count({
        where: {
          tenantId: tenantA,
          action: 'employee.account_provisioning_requested',
          resourceId: employeeIds.hrRequest,
        },
      }),
    ).toBe(1);
  });

  it('allows owners but denies employee roles, missing MFA, and cross-tenant selectors', async () => {
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.employee, mfaVerified: true },
        tenantA,
        employeeIds.ownerRequest,
        randomUUID(),
        { email: 'employee@example.com' },
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.owner, mfaVerified: false },
        tenantA,
        employeeIds.ownerRequest,
        randomUUID(),
        { email: 'employee@example.com' },
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.hr, mfaVerified: true },
        tenantB,
        employeeIds.otherTenant,
        randomUUID(),
        { email: 'employee@example.com' },
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.hr, mfaVerified: true },
        tenantA,
        employeeIds.otherTenant,
        randomUUID(),
        { email: 'employee@example.com' },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.owner, mfaVerified: true },
        tenantA,
        employeeIds.terminated,
        randomUUID(),
        { email: 'terminated@example.com' },
      ),
    ).rejects.toThrow('NOT_FOUND');

    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.owner, mfaVerified: true },
        tenantA,
        employeeIds.ownerRequest,
        randomUUID(),
        { email: 'owner-created@example.com' },
      ),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('serializes concurrent requests and refuses changed identity binding', async () => {
    const call = (key: string) =>
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.hr, mfaVerified: true },
        tenantA,
        employeeIds.concurrent,
        key,
        { email: 'concurrent@example.com' },
      );
    const [first, second] = await Promise.all([
      call(randomUUID()),
      call(randomUUID()),
    ]);
    expect(first.accountRequestId).toBe(second.accountRequestId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(
      await admin.employeeAccountRequest.count({
        where: { tenantId: tenantA, employeeId: employeeIds.concurrent },
      }),
    ).toBe(1);
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.hr, mfaVerified: true },
        tenantA,
        employeeIds.concurrent,
        randomUUID(),
        { email: 'changed@example.com' },
      ),
    ).rejects.toThrow('CONFLICT');

    const reusedKey = randomUUID();
    await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.hr, mfaVerified: true },
      tenantA,
      employeeIds.unused,
      reusedKey,
      { email: 'unused@example.com' },
    );
    await expect(
      requestEmployeeAccountProvisioning(
        runtime,
        { identityId: identityIds.hr, mfaVerified: true },
        tenantA,
        employeeIds.concurrent,
        reusedKey,
        { email: 'concurrent@example.com' },
      ),
    ).rejects.toThrow('CONFLICT');
  });

  it('keeps the request table private and uses the constrained function owner', async () => {
    await expect(runtime.employeeAccountRequest.findMany()).rejects.toThrow();
    await expect(
      runtime.employeeAccountRequest.create({
        data: {
          id: randomUUID(),
          requestKey: randomUUID(),
          tenantId: tenantA,
          employeeId: employeeIds.unused,
          requestedByIdentityId: identityIds.hr,
          email: 'forged@example.com',
        },
      }),
    ).rejects.toThrow();
    const [owner] = await admin.$queryRaw<
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
      WHERE p.proname = 'request_employee_account_provisioning'`;
    expect(owner).toEqual({
      owner: 'kinto_control_owner',
      login: false,
      bypass: false,
      appCanExecute: true,
    });
  });
});
