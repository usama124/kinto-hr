import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, listTenantSecurityAudit } from '@kinto/database';

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
    'Security audit tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let hrId: string;
let otherOwnerId: string;
let eventIds: string[];

const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});

describe('tenant security audit boundary', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    hrId = randomUUID();
    otherOwnerId = randomUUID();
    eventIds = Array.from({ length: 5 }, () => randomUUID());
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic audit tenant',
        employeeLimit: 10,
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, hrId, otherOwnerId].map((id) => ({
        id,
        issuer: 'https://audit.synthetic.example/realm',
        subject: randomUUID(),
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        { tenantId, identityId: hrId, roles: ['hr_admin'] },
        { tenantId: otherTenantId, identityId: otherOwnerId, roles: ['owner'] },
      ],
    });
    await admin.auditEvent.createMany({
      data: [
        {
          id: eventIds[0],
          tenantId,
          actorId: ownerId,
          action: 'company.created',
          resourceId: tenantId,
          createdAt: new Date('2026-09-01T00:00:00Z'),
        },
        {
          id: eventIds[1],
          tenantId,
          actorId: ownerId,
          action: 'membership.roles_changed',
          reason: 'Approved access',
          resourceId: hrId,
          createdAt: new Date('2026-09-02T00:00:00Z'),
        },
        {
          id: eventIds[2],
          tenantId,
          actorId: ownerId,
          action: 'membership.revoked',
          reason: 'Access ended',
          resourceId: hrId,
          createdAt: new Date('2026-09-03T00:00:00Z'),
        },
        {
          id: eventIds[3],
          tenantId: otherTenantId,
          actorId: otherOwnerId,
          action: 'company.created',
          resourceId: otherTenantId,
          createdAt: new Date('2026-09-04T00:00:00Z'),
        },
        {
          id: eventIds[4],
          tenantId: otherTenantId,
          actorId: otherOwnerId,
          action: 'membership.roles_changed',
          resourceId: otherOwnerId,
          createdAt: new Date('2026-09-05T00:00:00Z'),
        },
      ],
    });
  });

  afterEach(async () => {
    await admin.auditEvent.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await admin.membership.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await admin.identity.deleteMany({
      where: { id: { in: [ownerId, hrId, otherOwnerId] } },
    });
  });

  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('returns a safe newest-first projection with duplicate-free keyset pages', async () => {
    const first = await listTenantSecurityAudit(
      runtime,
      actor(ownerId),
      tenantId,
      { limit: 2 },
    );
    expect(first.items.map(({ id }) => id)).toEqual([eventIds[2], eventIds[1]]);
    expect(first.items[0]).toEqual({
      id: eventIds[2],
      actorId: ownerId,
      action: 'membership.revoked',
      reason: 'Access ended',
      resourceId: hrId,
      createdAt: new Date('2026-09-03T00:00:00Z'),
    });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{48}$/);
    const second = await listTenantSecurityAudit(
      runtime,
      actor(ownerId),
      tenantId,
      {
        limit: 2,
        cursor: first.nextCursor!,
      },
    );
    expect(second.items.map(({ id }) => id)).toEqual([eventIds[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it('applies exact action and inclusive time filters', async () => {
    const page = await listTenantSecurityAudit(
      runtime,
      actor(ownerId),
      tenantId,
      {
        action: 'membership.roles_changed',
        from: '2026-09-02T00:00:00Z',
        to: '2026-09-02T00:00:00Z',
      },
    );
    expect(page.items.map(({ id }) => id)).toEqual([eventIds[1]]);
  });

  it('denies non-owners, stale MFA, cross-tenant access and cross-tenant cursors', async () => {
    await expect(
      listTenantSecurityAudit(runtime, actor(hrId), tenantId, {}),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      listTenantSecurityAudit(runtime, actor(ownerId, false), tenantId, {}),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      listTenantSecurityAudit(runtime, actor(ownerId), otherTenantId, {}),
    ).rejects.toThrow('FORBIDDEN');
    const otherPage = await listTenantSecurityAudit(
      runtime,
      actor(otherOwnerId),
      otherTenantId,
      { limit: 1 },
    );
    await expect(
      listTenantSecurityAudit(runtime, actor(ownerId), tenantId, {
        cursor: otherPage.nextCursor!,
      }),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('keeps audit rows immutable to the runtime and uses the constrained function owner', async () => {
    await expect(
      runtime.auditEvent.update({
        where: { id: eventIds[0] },
        data: { action: 'changed' },
      }),
    ).rejects.toThrow();
    const functions = await admin.$queryRaw<
      { owner: string; login: boolean; bypass: boolean; executable: boolean }[]
    >`SELECT r.rolname AS owner, r.rolcanlogin AS login, r.rolbypassrls AS bypass,
      has_function_privilege('kinto_app', p.oid, 'EXECUTE') AS executable
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname = 'list_tenant_security_audit'`;
    expect(functions).toEqual([
      {
        owner: 'kinto_control_owner',
        login: false,
        bypass: false,
        executable: true,
      },
    ]);
    expect(
      await runtime.$queryRaw<{ outcome: string }[]>`
        SELECT outcome FROM public.list_tenant_security_audit(
          ${ownerId}::uuid, ${true}, ${tenantId}::uuid, ${null}::integer,
          ${null}::varchar, ${null}::timestamptz, ${null}::timestamptz,
          ${null}::uuid
        )
      `,
    ).toEqual([{ outcome: 'conflict' }]);
  });
});
