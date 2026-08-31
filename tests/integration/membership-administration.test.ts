import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  listTenantMemberships,
  revokeTenantMembership,
  updateTenantMembershipRoles,
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
  throw new Error('Membership tests require synthetic kinto_test databases');

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let employeeId: string;
let invitationId: string;
let requestId: string;
let linkId: string;
let identities: Record<
  'ownerA' | 'ownerB' | 'hr' | 'employee' | 'intruder',
  string
>;
let memberships: Record<
  'ownerA' | 'ownerB' | 'hr' | 'employee' | 'intruder',
  string
>;

const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});

describe('owner membership administration boundary', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    employeeId = randomUUID();
    invitationId = randomUUID();
    requestId = randomUUID();
    linkId = randomUUID();
    identities = {
      ownerA: randomUUID(),
      ownerB: randomUUID(),
      hr: randomUUID(),
      employee: randomUUID(),
      intruder: randomUUID(),
    };
    memberships = {
      ownerA: randomUUID(),
      ownerB: randomUUID(),
      hr: randomUUID(),
      employee: randomUUID(),
      intruder: randomUUID(),
    };
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic membership tenant',
        employeeLimit: 10,
      })),
    });
    await admin.identity.createMany({
      data: Object.entries(identities).map(([name, id]) => ({
        id,
        issuer: 'https://memberships.synthetic.example/realm',
        subject: `${name}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        {
          id: memberships.ownerA,
          tenantId,
          identityId: identities.ownerA,
          roles: ['owner'],
        },
        {
          id: memberships.ownerB,
          tenantId,
          identityId: identities.ownerB,
          roles: ['owner'],
        },
        {
          id: memberships.hr,
          tenantId,
          identityId: identities.hr,
          roles: ['hr_admin'],
        },
        {
          id: memberships.employee,
          tenantId,
          identityId: identities.employee,
          roles: ['employee'],
        },
        {
          id: memberships.intruder,
          tenantId: otherTenantId,
          identityId: identities.intruder,
          roles: ['owner'],
        },
      ],
    });
    await admin.employee.create({
      data: {
        id: employeeId,
        tenantId,
        employeeNumber: 'LINKED-001',
        name: 'Linked employee',
      },
    });
    await admin.employeeAccountRequest.create({
      data: {
        id: requestId,
        requestKey: randomUUID(),
        tenantId,
        employeeId,
        requestedByIdentityId: identities.ownerA,
        email: 'linked@example.com',
        status: 'active',
      },
    });
    await admin.employeeInvitation.create({
      data: {
        id: invitationId,
        requestId,
        tenantId,
        employeeId,
        identityId: identities.employee,
        status: 'accepted',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await admin.employeeIdentityLink.create({
      data: {
        id: linkId,
        tenantId,
        employeeId,
        identityId: identities.employee,
        membershipId: memberships.employee,
        invitationId,
      },
    });
  });

  afterEach(async () => {
    await admin.auditEvent.deleteMany({ where: { tenantId } });
    await admin.employeeIdentityLink.deleteMany({ where: { tenantId } });
    await admin.employeeInvitation.deleteMany({ where: { tenantId } });
    await admin.employeeAccountRequest.deleteMany({ where: { tenantId } });
    await admin.membership.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await admin.employee.deleteMany({ where: { tenantId } });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await admin.identity.deleteMany({
      where: { id: { in: Object.values(identities) } },
    });
  });

  afterAll(async () => {
    await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  });

  it('lists only for a recent-MFA owner and identifies protected employee links', async () => {
    const result = await listTenantMemberships(
      runtime,
      actor(identities.ownerA),
      tenantId,
    );
    expect(result).toHaveLength(4);
    expect(result.find(({ id }) => id === memberships.employee)).toMatchObject({
      identityId: identities.employee,
      roles: ['employee'],
      employeeId,
      status: 'active',
      version: 1,
    });
    await expect(
      listTenantMemberships(runtime, actor(identities.hr), tenantId),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      listTenantMemberships(runtime, actor(identities.ownerA, false), tenantId),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      listTenantMemberships(runtime, actor(identities.ownerA), otherTenantId),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('changes canonical roles with optimistic concurrency and a durable reason', async () => {
    const updated = await updateTenantMembershipRoles(
      runtime,
      actor(identities.ownerA),
      tenantId,
      memberships.hr,
      {
        expectedVersion: 1,
        roles: ['payroll_approver', 'hr_admin'],
        reason: 'Approved combined HR and review responsibility',
      },
    );
    expect(updated).toEqual({
      id: memberships.hr,
      status: 'active',
      roles: ['hr_admin', 'payroll_approver'],
      version: 2,
    });
    expect(
      await admin.auditEvent.findFirstOrThrow({
        where: { tenantId, resourceId: memberships.hr },
      }),
    ).toMatchObject({
      actorId: identities.ownerA,
      action: 'membership.roles_changed',
      reason: 'Approved combined HR and review responsibility',
    });
    await expect(
      updateTenantMembershipRoles(
        runtime,
        actor(identities.ownerA),
        tenantId,
        memberships.hr,
        { expectedVersion: 1, roles: ['hr_admin'], reason: 'Stale update' },
      ),
    ).rejects.toThrow('STALE_VERSION');
  });

  it('rejects non-owners, missing MFA, cross-tenant targets and no-op updates', async () => {
    for (const caller of [
      actor(identities.hr),
      actor(identities.ownerA, false),
      actor(identities.intruder),
    ])
      await expect(
        updateTenantMembershipRoles(runtime, caller, tenantId, memberships.hr, {
          expectedVersion: 1,
          roles: ['payroll_preparer'],
          reason: 'Denied change',
        }),
      ).rejects.toThrow('FORBIDDEN');
    await expect(
      updateTenantMembershipRoles(
        runtime,
        actor(identities.ownerA),
        tenantId,
        memberships.intruder,
        { expectedVersion: 1, roles: ['hr_admin'], reason: 'Wrong tenant' },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      updateTenantMembershipRoles(
        runtime,
        actor(identities.ownerA),
        tenantId,
        memberships.hr,
        { expectedVersion: 1, roles: ['hr_admin'], reason: 'No actual change' },
      ),
    ).rejects.toThrow('CONFLICT');
  });

  it('keeps direct function calls fail-closed and canonical at the database boundary', async () => {
    expect(
      await runtime.$queryRaw<{ outcome: string }[]>`
        SELECT outcome FROM public.list_tenant_memberships(
          ${identities.ownerA}::uuid, ${null}::boolean, ${tenantId}::uuid
        )`,
    ).toEqual([{ outcome: 'forbidden' }]);
    const updated = await runtime.$queryRaw<
      { outcome: string; membership_roles: string[] }[]
    >`
      SELECT outcome, membership_roles FROM public.mutate_tenant_membership(
        ${identities.ownerA}::uuid, true, ${tenantId}::uuid,
        ${memberships.hr}::uuid, 1,
        ARRAY['payroll_approver', 'hr_admin']::text[], false,
        'Direct constrained function test'::varchar, ${randomUUID()}::uuid
      )`;
    expect(updated).toEqual([
      {
        outcome: 'updated',
        membership_roles: ['hr_admin', 'payroll_approver'],
      },
    ]);
    for (const query of [
      runtime.$queryRaw<{ outcome: string }[]>`
        SELECT outcome FROM public.mutate_tenant_membership(
          ${identities.ownerA}::uuid, true, ${tenantId}::uuid,
          ${memberships.hr}::uuid, ${null}::integer,
          ARRAY['hr_admin']::text[], false, 'Missing version'::varchar,
          ${randomUUID()}::uuid
        )`,
      runtime.$queryRaw<{ outcome: string }[]>`
        SELECT outcome FROM public.mutate_tenant_membership(
          ${identities.ownerA}::uuid, true, ${tenantId}::uuid,
          ${memberships.hr}::uuid, 2,
          ARRAY['hr_admin']::text[], false, E'\t\t\t'::varchar,
          ${randomUUID()}::uuid
        )`,
    ])
      await expect(query).resolves.toEqual([{ outcome: 'conflict' }]);
  });

  it('revokes administrative access but protects linked employees', async () => {
    expect(
      await revokeTenantMembership(
        runtime,
        actor(identities.ownerA),
        tenantId,
        memberships.hr,
        { expectedVersion: 1, reason: 'Administrator access removed' },
      ),
    ).toEqual({
      id: memberships.hr,
      status: 'revoked',
      roles: ['hr_admin'],
      version: 2,
    });
    await expect(
      revokeTenantMembership(
        runtime,
        actor(identities.ownerA),
        tenantId,
        memberships.employee,
        { expectedVersion: 1, reason: 'Must use employee offboarding' },
      ),
    ).rejects.toThrow('INVALID_STATE');
  });

  it('serializes concurrent owner demotions so one active owner always remains', async () => {
    const changes = await Promise.allSettled([
      updateTenantMembershipRoles(
        runtime,
        actor(identities.ownerA),
        tenantId,
        memberships.ownerA,
        {
          expectedVersion: 1,
          roles: ['hr_admin'],
          reason: 'Owner A steps down',
        },
      ),
      updateTenantMembershipRoles(
        runtime,
        actor(identities.ownerB),
        tenantId,
        memberships.ownerB,
        {
          expectedVersion: 1,
          roles: ['hr_admin'],
          reason: 'Owner B steps down',
        },
      ),
    ]);
    expect(changes.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(changes.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await admin.membership.count({
        where: { tenantId, status: 'active', roles: { has: 'owner' } },
      }),
    ).toBe(1);
  });
});
