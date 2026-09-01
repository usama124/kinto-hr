import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  findActiveIdentity,
  markAdministratorInvitationDelivered,
  reconcileAdministratorInvitationProvider,
  requestAdministratorInvitation,
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
    'Administrator invitation tests require kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantA: string;
let tenantB: string;
let identities: Record<'owner' | 'hr' | 'otherOwner' | 'existing', string>;
const providerIds: string[] = [];
const issuer =
  'https://administrator-invitations.synthetic.example/realms/kinto';
const expires = () => new Date(Date.now() + 48 * 60 * 60 * 1000);

describe('administrator invitation boundary', () => {
  beforeEach(async () => {
    tenantA = randomUUID();
    tenantB = randomUUID();
    identities = {
      owner: randomUUID(),
      hr: randomUUID(),
      otherOwner: randomUUID(),
      existing: randomUUID(),
    };
    await admin.tenant.createMany({
      data: [tenantA, tenantB].map((id) => ({
        id,
        name: 'Synthetic administrator tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: Object.entries(identities).map(([name, id]) => ({
        id,
        issuer,
        subject: `${name}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId: tenantA, identityId: identities.owner, roles: ['owner'] },
        { tenantId: tenantA, identityId: identities.hr, roles: ['hr_admin'] },
        {
          tenantId: tenantB,
          identityId: identities.otherOwner,
          roles: ['owner'],
        },
        {
          tenantId: tenantB,
          identityId: identities.existing,
          roles: ['employee'],
        },
      ],
    });
  });

  afterEach(async () => {
    const tenantIds = [tenantA, tenantB];
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.administratorInvitation.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.administratorAccountRequest.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.employeeInvitation.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.employeeAccountRequest.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.membership.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.employee.deleteMany({
      where: { tenantId: { in: tenantIds } },
    });
    await admin.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await admin.identity.deleteMany({
      where: {
        id: { in: [...Object.values(identities), ...providerIds.splice(0)] },
      },
    });
  });

  afterAll(async () => {
    await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  });

  const invite = (email: string, requestKey = randomUUID()) =>
    requestAdministratorInvitation(
      runtime,
      { identityId: identities.owner, mfaVerified: true },
      tenantA,
      requestKey,
      {
        email,
        roles: ['payroll_approver', 'hr_admin'],
        reason: 'Approved operational responsibilities',
      },
    );

  it('records one canonical access-neutral request and exact replays', async () => {
    const identityCount = await admin.identity.count();
    const membershipCount = await admin.membership.count();
    const key = randomUUID();
    const created = await invite(' Admin@Example.COM ', key);
    expect(created).toMatchObject({
      status: 'pending_identity_provider',
      replayed: false,
    });
    expect(await invite('admin@example.com', key)).toEqual({
      ...created,
      replayed: true,
    });
    expect(
      await admin.administratorAccountRequest.findUniqueOrThrow({
        where: { id: created.accountRequestId },
      }),
    ).toMatchObject({
      tenantId: tenantA,
      requestedByIdentityId: identities.owner,
      email: 'admin@example.com',
      roles: ['hr_admin', 'payroll_approver'],
      reason: 'Approved operational responsibilities',
    });
    expect(await admin.identity.count()).toBe(identityCount);
    expect(await admin.membership.count()).toBe(membershipCount);
    expect(
      await admin.auditEvent.count({
        where: {
          tenantId: tenantA,
          action: 'administrator.invitation_requested',
        },
      }),
    ).toBe(1);
  });

  it('denies HR, missing MFA and cross-tenant authority and rejects changed bindings', async () => {
    for (const [identityId, mfaVerified, tenantId] of [
      [identities.hr, true, tenantA],
      [identities.owner, false, tenantA],
      [identities.owner, true, tenantB],
    ] as const)
      await expect(
        requestAdministratorInvitation(
          runtime,
          { identityId, mfaVerified },
          tenantId,
          randomUUID(),
          {
            email: 'denied@example.com',
            roles: ['owner'],
            reason: 'Denied request',
          },
        ),
      ).rejects.toThrow('FORBIDDEN');
    await invite('binding@example.com');
    await expect(
      requestAdministratorInvitation(
        runtime,
        { identityId: identities.owner, mfaVerified: true },
        tenantA,
        randomUUID(),
        {
          email: 'binding@example.com',
          roles: ['owner'],
          reason: 'Changed access',
        },
      ),
    ).rejects.toThrow('CONFLICT');
  });

  it('serializes concurrent requests for one tenant email', async () => {
    const [first, second] = await Promise.all([
      invite('concurrent@example.com'),
      invite('concurrent@example.com'),
    ]);
    expect(first.accountRequestId).toBe(second.accountRequestId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(
      await admin.administratorAccountRequest.count({
        where: { tenantId: tenantA, email: 'concurrent@example.com' },
      }),
    ).toBe(1);
  });

  it('delivers and activates only the exact provider subject after MFA', async () => {
    const requested = await invite('activated@example.com');
    const provider = { issuer, subject: `activated-${randomUUID()}` };
    const expiry = expires();
    const reconciled = await reconcileAdministratorInvitationProvider(
      runtime,
      requested.accountRequestId,
      provider,
      expiry,
    );
    const identity = await admin.identity.findUniqueOrThrow({
      where: { issuer_subject: provider },
    });
    providerIds.push(identity.id);
    expect(reconciled).toMatchObject({
      status: 'pending_delivery',
      replayed: false,
    });
    expect(
      await markAdministratorInvitationDelivered(
        runtime,
        requested.accountRequestId,
        expiry,
      ),
    ).toEqual({ status: 'pending_activation', replayed: false });
    await findActiveIdentity(runtime, { ...provider, mfaVerified: false });
    expect(
      await admin.membership.count({
        where: { tenantId: tenantA, identityId: identity.id },
      }),
    ).toBe(0);
    await findActiveIdentity(runtime, { ...provider, mfaVerified: true });
    expect(
      await admin.membership.findUniqueOrThrow({
        where: {
          tenantId_identityId: { tenantId: tenantA, identityId: identity.id },
        },
      }),
    ).toMatchObject({
      roles: ['hr_admin', 'payroll_approver'],
      status: 'active',
    });
    await findActiveIdentity(runtime, { ...provider, mfaVerified: true });
    expect(
      await admin.membership.count({
        where: { tenantId: tenantA, identityId: identity.id },
      }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId: tenantA, action: 'administrator.account_activated' },
      }),
    ).toBe(1);
  });

  it('allows an existing identity from another tenant but refuses same-tenant access', async () => {
    const existing = await invite('existing@example.com');
    const provider = await admin.identity.findUniqueOrThrow({
      where: { id: identities.existing },
    });
    const expiry = expires();
    await reconcileAdministratorInvitationProvider(
      runtime,
      existing.accountRequestId,
      { issuer: provider.issuer, subject: provider.subject },
      expiry,
    );
    await markAdministratorInvitationDelivered(
      runtime,
      existing.accountRequestId,
      expiry,
    );
    await findActiveIdentity(runtime, {
      issuer: provider.issuer,
      subject: provider.subject,
      mfaVerified: true,
    });
    expect(
      await admin.membership.count({
        where: { identityId: identities.existing },
      }),
    ).toBe(2);

    const sameTenant = await invite('same-tenant@example.com');
    const owner = await admin.identity.findUniqueOrThrow({
      where: { id: identities.owner },
    });
    await expect(
      reconcileAdministratorInvitationProvider(
        runtime,
        sameTenant.accountRequestId,
        { issuer: owner.issuer, subject: owner.subject },
        expires(),
      ),
    ).rejects.toThrow('CONFLICT');
  });

  it('keeps tables private and exposes only constrained control functions', async () => {
    await expect(
      runtime.administratorAccountRequest.findMany(),
    ).rejects.toThrow();
    await expect(runtime.administratorInvitation.findMany()).rejects.toThrow();
    const functions = await admin.$queryRaw<
      {
        name: string;
        owner: string;
        login: boolean;
        bypass: boolean;
        executable: boolean;
      }[]
    >`SELECT p.proname AS name, r.rolname AS owner, r.rolcanlogin AS login,
      r.rolbypassrls AS bypass,
      has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS executable
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname IN (
        'request_administrator_invitation',
        'reconcile_administrator_invitation_provider',
        'mark_administrator_invitation_delivered'
      ) ORDER BY p.proname`;
    expect(functions).toHaveLength(3);
    expect(
      functions.every(
        (fn) =>
          fn.owner === 'kinto_control_owner' &&
          !fn.login &&
          !fn.bypass &&
          fn.executable,
      ),
    ).toBe(true);
    expect(
      await admin.$queryRaw<
        { owner: string; executable: boolean }[]
      >`SELECT r.rolname AS owner,
        has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS executable
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'resolve_login_identity_pre_administrator'`,
    ).toEqual([{ owner: 'kinto_control_owner', executable: false }]);
  });

  it('prevents overlapping invitation types for one provider identity', async () => {
    const employee = await admin.employee.create({
      data: {
        tenantId: tenantA,
        employeeNumber: 'PENDING-IDENTITY',
        name: 'Pending identity collision',
      },
    });
    const employeeRequest = await admin.employeeAccountRequest.create({
      data: {
        id: randomUUID(),
        requestKey: randomUUID(),
        tenantId: tenantA,
        employeeId: employee.id,
        requestedByIdentityId: identities.owner,
        email: 'employee-collision@example.com',
      },
    });
    await admin.employeeInvitation.create({
      data: {
        id: randomUUID(),
        requestId: employeeRequest.id,
        tenantId: tenantA,
        employeeId: employee.id,
        identityId: identities.existing,
        expiresAt: expires(),
      },
    });
    const request = await invite('administrator-collision@example.com');
    const provider = await admin.identity.findUniqueOrThrow({
      where: { id: identities.existing },
    });
    await expect(
      reconcileAdministratorInvitationProvider(
        runtime,
        request.accountRequestId,
        { issuer: provider.issuer, subject: provider.subject },
        expires(),
      ),
    ).rejects.toThrow('CONFLICT');
  });
});
