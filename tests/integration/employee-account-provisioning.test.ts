import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  findActiveIdentity,
  markEmployeeInvitationDelivered,
  reconcileCompanyOwnerProvider,
  reconcileEmployeeAccountProvider,
  requestCompanyProvisioning,
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
  activation: randomUUID(),
  expired: randomUUID(),
  memberConflict: randomUUID(),
  employeePendingCollision: randomUUID(),
  ownerPendingCollision: randomUUID(),
};
const providerIdentityIds: string[] = [];
const collisionTenantIds: string[] = [];

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
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: collisionTenantIds } },
    });
    await admin.ownerInvitation.deleteMany({
      where: { tenantId: { in: collisionTenantIds } },
    });
    await admin.companyProvisioningRequest.deleteMany({
      where: { tenantId: { in: collisionTenantIds } },
    });
    await admin.platformAuditEvent.deleteMany({
      where: { actorId: identityIds.otherOwner },
    });
    await admin.platformOperator.deleteMany({
      where: { identityId: identityIds.otherOwner },
    });
    await admin.employeeIdentityLink.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
    await admin.employeeInvitation.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
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
    await admin.tenant.deleteMany({
      where: { id: { in: collisionTenantIds } },
    });
    await admin.identity.deleteMany({
      where: {
        id: { in: [...Object.values(identityIds), ...providerIdentityIds] },
      },
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
    await expect(runtime.employeeInvitation.findMany()).rejects.toThrow();
    await expect(runtime.employeeIdentityLink.findMany()).rejects.toThrow();
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
    const owners = await admin.$queryRaw<
      {
        name: string;
        owner: string;
        login: boolean;
        bypass: boolean;
        appCanExecute: boolean;
      }[]
    >`SELECT p.proname AS name, r.rolname AS owner, r.rolcanlogin AS login,
      r.rolbypassrls AS bypass,
      has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS "appCanExecute"
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname IN (
        'request_employee_account_provisioning',
        'reconcile_employee_account_provider',
        'mark_employee_invitation_delivered'
      ) ORDER BY p.proname`;
    expect(owners).toHaveLength(3);
    expect(owners.map(({ name }) => name)).toEqual([
      'mark_employee_invitation_delivered',
      'reconcile_employee_account_provider',
      'request_employee_account_provisioning',
    ]);
    expect(owners).toEqual(
      owners.map(({ name }) => ({
        name,
        owner: 'kinto_control_owner',
        login: false,
        bypass: false,
        appCanExecute: true,
      })),
    );
  });

  it('delivers and atomically activates one fixed employee membership and identity link', async () => {
    const requested = await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.hr, mfaVerified: true },
      tenantA,
      employeeIds.activation,
      randomUUID(),
      { email: 'activated@example.com' },
    );
    const provider = {
      issuer: 'https://employee-provider.synthetic.example/realms/kinto',
      subject: randomUUID(),
    };
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const invitation = await reconcileEmployeeAccountProvider(
      runtime,
      requested.accountRequestId,
      provider,
      expiresAt,
    );
    const identity = await admin.identity.findUniqueOrThrow({
      where: { issuer_subject: provider },
    });
    providerIdentityIds.push(identity.id);
    expect(invitation).toMatchObject({
      status: 'pending_delivery',
      replayed: false,
    });
    expect(
      await reconcileEmployeeAccountProvider(
        runtime,
        requested.accountRequestId,
        provider,
        expiresAt,
      ),
    ).toMatchObject({ invitationId: invitation.invitationId, replayed: true });
    expect(
      await markEmployeeInvitationDelivered(
        runtime,
        requested.accountRequestId,
        expiresAt,
      ),
    ).toEqual({ status: 'pending_activation', replayed: false });
    expect(
      await markEmployeeInvitationDelivered(
        runtime,
        requested.accountRequestId,
        expiresAt,
      ),
    ).toEqual({ status: 'pending_activation', replayed: true });
    expect(
      await findActiveIdentity(runtime, { ...provider, mfaVerified: false }),
    ).toEqual({ id: identity.id, ownerActivated: false });
    expect(
      await admin.membership.count({
        where: { tenantId: tenantA, identityId: identity.id },
      }),
    ).toBe(0);

    await Promise.all([
      findActiveIdentity(runtime, { ...provider, mfaVerified: true }),
      findActiveIdentity(runtime, { ...provider, mfaVerified: true }),
    ]);
    const membership = await admin.membership.findUniqueOrThrow({
      where: {
        tenantId_identityId: { tenantId: tenantA, identityId: identity.id },
      },
    });
    expect(membership.roles).toEqual(['employee']);
    expect(membership.status).toBe('active');
    expect(
      await admin.employeeIdentityLink.findUniqueOrThrow({
        where: {
          tenantId_employeeId: {
            tenantId: tenantA,
            employeeId: employeeIds.activation,
          },
        },
      }),
    ).toMatchObject({
      identityId: identity.id,
      membershipId: membership.id,
      invitationId: invitation.invitationId,
    });
    expect(
      await admin.employeeInvitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
      }),
    ).toMatchObject({ status: 'accepted' });
    expect(
      await admin.employeeAccountRequest.findUniqueOrThrow({
        where: { id: requested.accountRequestId },
      }),
    ).toMatchObject({ status: 'active' });
    expect(
      await admin.auditEvent.count({
        where: {
          tenantId: tenantA,
          action: 'employee.account_activated',
          resourceId: (
            await admin.employeeIdentityLink.findUniqueOrThrow({
              where: { membershipId: membership.id },
            })
          ).id,
        },
      }),
    ).toBe(1);
  });

  it('rejects wrong identity, expired setup and an existing company membership', async () => {
    const requested = await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.owner, mfaVerified: true },
      tenantA,
      employeeIds.expired,
      randomUUID(),
      { email: 'expired@example.com' },
    );
    const provider = {
      issuer: 'https://employee-provider.synthetic.example/realms/kinto',
      subject: randomUUID(),
    };
    const invitation = await reconcileEmployeeAccountProvider(
      runtime,
      requested.accountRequestId,
      provider,
      new Date(Date.now() + 48 * 60 * 60 * 1000),
    );
    const identity = await admin.identity.findUniqueOrThrow({
      where: { issuer_subject: provider },
    });
    providerIdentityIds.push(identity.id);
    await markEmployeeInvitationDelivered(
      runtime,
      requested.accountRequestId,
      new Date(Date.now() + 48 * 60 * 60 * 1000),
    );
    const wrong = await admin.identity.create({
      data: { issuer: provider.issuer, subject: randomUUID() },
    });
    providerIdentityIds.push(wrong.id);
    expect(
      await findActiveIdentity(
        runtime,
        { issuer: provider.issuer, subject: wrong.subject, mfaVerified: true },
        invitation.invitationId,
      ),
    ).toEqual({ id: wrong.id, ownerActivated: false });
    await admin.employeeInvitation.update({
      where: { id: invitation.invitationId },
      data: { expiresAt: new Date(0) },
    });
    expect(
      await findActiveIdentity(
        runtime,
        { ...provider, mfaVerified: true },
        invitation.invitationId,
      ),
    ).toEqual({ id: identity.id, ownerActivated: false });
    expect(
      await admin.membership.count({
        where: { tenantId: tenantA, identityId: identity.id },
      }),
    ).toBe(0);

    const memberRequest = await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.owner, mfaVerified: true },
      tenantA,
      employeeIds.memberConflict,
      randomUUID(),
      { email: 'owner-identity@example.com' },
    );
    const existingOwner = await admin.identity.findUniqueOrThrow({
      where: { id: identityIds.owner },
    });
    await expect(
      reconcileEmployeeAccountProvider(
        runtime,
        memberRequest.accountRequestId,
        { issuer: existingOwner.issuer, subject: existingOwner.subject },
        new Date(Date.now() + 48 * 60 * 60 * 1000),
      ),
    ).rejects.toThrow('CONFLICT');
    expect(
      await admin.employeeAccountRequest.findUniqueOrThrow({
        where: { id: memberRequest.accountRequestId },
      }),
    ).toMatchObject({ status: 'pending_identity_provider' });
  });

  it('prevents one provider identity from holding pending owner and employee activation', async () => {
    await admin.platformOperator.create({
      data: { identityId: identityIds.otherOwner },
    });
    const employeeFirst = await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.owner, mfaVerified: true },
      tenantA,
      employeeIds.employeePendingCollision,
      randomUUID(),
      { email: 'employee-first@example.com' },
    );
    const employeeProvider = {
      issuer: 'https://collision.synthetic.example/realms/kinto',
      subject: randomUUID(),
    };
    await reconcileEmployeeAccountProvider(
      runtime,
      employeeFirst.accountRequestId,
      employeeProvider,
      new Date(Date.now() + 48 * 60 * 60 * 1000),
    );
    providerIdentityIds.push(
      (
        await admin.identity.findUniqueOrThrow({
          where: { issuer_subject: employeeProvider },
        })
      ).id,
    );
    const ownerAfterEmployee = await requestCompanyProvisioning(
      runtime,
      { identityId: identityIds.otherOwner, mfaVerified: true },
      randomUUID(),
      {
        companyName: 'Synthetic employee-first collision',
        employeeLimit: 5,
        billingMode: 'free',
        initialOwnerEmail: 'employee-first@example.com',
      },
    );
    collisionTenantIds.push(ownerAfterEmployee.tenantId);
    await expect(
      reconcileCompanyOwnerProvider(
        runtime,
        ownerAfterEmployee.provisioningRequestId,
        employeeProvider,
        new Date(Date.now() + 48 * 60 * 60 * 1000),
      ),
    ).rejects.toThrow('CONFLICT');

    const ownerProvider = {
      issuer: 'https://collision.synthetic.example/realms/kinto',
      subject: randomUUID(),
    };
    const ownerFirst = await requestCompanyProvisioning(
      runtime,
      { identityId: identityIds.otherOwner, mfaVerified: true },
      randomUUID(),
      {
        companyName: 'Synthetic owner-first collision',
        employeeLimit: 5,
        billingMode: 'free',
        initialOwnerEmail: 'owner-first@example.com',
      },
    );
    collisionTenantIds.push(ownerFirst.tenantId);
    await reconcileCompanyOwnerProvider(
      runtime,
      ownerFirst.provisioningRequestId,
      ownerProvider,
      new Date(Date.now() + 48 * 60 * 60 * 1000),
    );
    providerIdentityIds.push(
      (
        await admin.identity.findUniqueOrThrow({
          where: { issuer_subject: ownerProvider },
        })
      ).id,
    );
    const employeeAfterOwner = await requestEmployeeAccountProvisioning(
      runtime,
      { identityId: identityIds.owner, mfaVerified: true },
      tenantA,
      employeeIds.ownerPendingCollision,
      randomUUID(),
      { email: 'owner-first@example.com' },
    );
    await expect(
      reconcileEmployeeAccountProvider(
        runtime,
        employeeAfterOwner.accountRequestId,
        ownerProvider,
        new Date(Date.now() + 48 * 60 * 60 * 1000),
      ),
    ).rejects.toThrow('CONFLICT');
  });
});
