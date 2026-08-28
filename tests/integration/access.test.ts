import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, inAuthorizedTenant, inTenant } from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (
  !adminUrl ||
  !appUrl ||
  [adminUrl, appUrl].some(
    (value) => !new URL(value).pathname.startsWith('/kinto_test'),
  )
)
  throw new Error('Access tests require kinto_test* databases');
const admin = createDatabase(adminUrl);
const app = createDatabase(
  `${appUrl}${appUrl.includes('?') ? '&' : '?'}connection_limit=2`,
);
let tenantA: string;
let tenantB: string;
let identityId: string;
let membershipId: string;
let principal: { issuer: string; subject: string; mfaVerified: boolean };
describe('verified-identity membership authorization boundary', () => {
  beforeEach(async () => {
    tenantA = randomUUID();
    tenantB = randomUUID();
    identityId = randomUUID();
    membershipId = randomUUID();
    principal = {
      issuer: 'https://synthetic.example/realm',
      subject: randomUUID(),
      mfaVerified: true,
    };
    await admin.tenant.createMany({
      data: [tenantA, tenantB].map((id) => ({
        id,
        name: 'Synthetic access tenant',
        employeeLimit: 5,
      })),
    });
    await admin.identity.create({
      data: {
        id: identityId,
        issuer: principal.issuer,
        subject: principal.subject,
      },
    });
    await admin.membership.create({
      data: {
        id: membershipId,
        identityId,
        tenantId: tenantA,
        roles: ['hr_admin'],
      },
    });
  });
  afterEach(async () => {
    const where = { tenantId: { in: [tenantA, tenantB] } };
    await admin.membership.deleteMany({ where });
    await admin.employee.deleteMany({ where });
    await admin.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await admin.identity.deleteMany({ where: { subject: principal.subject } });
  });
  afterAll(async () => {
    await Promise.all([admin.$disconnect(), app.$disconnect()]);
  });

  it('resolves actor from current membership and keeps authorized writes inside its transaction', async () => {
    const created = await inAuthorizedTenant(
      app,
      principal,
      tenantA,
      'employees.write',
      async (tx, actor) => {
        expect(actor).toEqual({ identityId, membershipId });
        return tx.employee.create({
          data: {
            tenantId: tenantA,
            employeeNumber: '001',
            name: 'Synthetic authorized',
          },
        });
      },
    );
    expect(created.tenantId).toBe(tenantA);
    await expect(
      inAuthorizedTenant(
        app,
        principal,
        tenantA,
        'employees.write',
        async (tx) => {
          await tx.employee.create({
            data: {
              tenantId: tenantA,
              employeeNumber: '002',
              name: 'Rollback',
            },
          });
          throw new Error('rollback');
        },
      ),
    ).rejects.toThrow('rollback');
    expect(await admin.employee.count({ where: { tenantId: tenantA } })).toBe(
      1,
    );
  });
  it('rejects a tenant selector without membership before invoking any work', async () => {
    let invoked = false;
    await expect(
      inAuthorizedTenant(
        app,
        principal,
        tenantB,
        'employees.read',
        async () => {
          invoked = true;
        },
      ),
    ).rejects.toThrow('FORBIDDEN');
    expect(invoked).toBe(false);
    await expect(
      inAuthorizedTenant(app, principal, tenantA, 'employees.write', (tx) =>
        tx.employee.create({
          data: {
            tenantId: tenantB,
            employeeNumber: 'BAD',
            name: 'Cross tenant',
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('matches the issuer and subject exactly, without implicit identity or company creation', async () => {
    await expect(
      inAuthorizedTenant(
        app,
        { ...principal, issuer: 'https://other.example/realm' },
        tenantA,
        'employees.read',
        async () => true,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      inAuthorizedTenant(
        app,
        { ...principal, subject: 'unknown' },
        tenantA,
        'employees.read',
        async () => true,
      ),
    ).rejects.toThrow('FORBIDDEN');
    expect(await admin.membership.count({ where: { tenantId: tenantA } })).toBe(
      1,
    );
  });
  it('rejects missing MFA for privileged membership and never accepts supplied roles', async () => {
    await expect(
      inAuthorizedTenant(
        app,
        { ...principal, mfaVerified: false },
        tenantA,
        'employees.read',
        async () => true,
      ),
    ).rejects.toThrow('FORBIDDEN');
    const forged = { ...principal, roles: ['owner'] };
    await expect(
      inAuthorizedTenant(
        app,
        forged,
        tenantA,
        'employees.read',
        async () => true,
      ),
    ).rejects.toThrow();
  });
  it('does not grant salary/payroll access to HR or owners and does not grant employee administration to payroll roles', async () => {
    for (const role of ['hr_admin', 'owner', 'employee']) {
      await admin.membership.update({
        where: { id: membershipId },
        data: { roles: [role] },
      });
      await expect(
        inAuthorizedTenant(
          app,
          principal,
          tenantA,
          'payroll.prepare',
          async () => true,
        ),
      ).rejects.toThrow('FORBIDDEN');
    }
    await admin.membership.update({
      where: { id: membershipId },
      data: { roles: ['payroll_preparer'] },
    });
    expect(
      await inAuthorizedTenant(
        app,
        principal,
        tenantA,
        'payroll.prepare',
        async () => true,
      ),
    ).toBe(true);
    await expect(
      inAuthorizedTenant(
        app,
        principal,
        tenantA,
        'employees.read',
        async () => true,
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('checks membership revocation, identity disablement and tenant suspension on the next call', async () => {
    const access = () =>
      inAuthorizedTenant(
        app,
        principal,
        tenantA,
        'employees.read',
        async () => true,
      );
    expect(await access()).toBe(true);
    await admin.membership.update({
      where: { id: membershipId },
      data: { status: 'revoked', version: { increment: 1 } },
    });
    await expect(access()).rejects.toThrow('FORBIDDEN');
    await admin.membership.update({
      where: { id: membershipId },
      data: { status: 'active' },
    });
    await admin.identity.update({
      where: { id: identityId },
      data: { status: 'disabled' },
    });
    await expect(access()).rejects.toThrow('FORBIDDEN');
    await admin.identity.update({
      where: { id: identityId },
      data: { status: 'active' },
    });
    await admin.tenant.update({
      where: { id: tenantA },
      data: { status: 'suspended' },
    });
    await expect(access()).rejects.toThrow('TENANT_UNAVAILABLE');
  });
  it('fails closed for missing identity context and prevents runtime identity/membership provisioning', async () => {
    expect(await app.identity.findMany()).toEqual([]);
    expect(
      await inTenant(app, tenantA, (tx) => tx.membership.findMany()),
    ).toEqual([]);
    await expect(
      inAuthorizedTenant(app, principal, tenantA, 'employees.write', (tx) =>
        tx.membership.update({
          where: { id: membershipId },
          data: { roles: ['owner'] },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      app.identity.create({
        data: { issuer: principal.issuer, subject: 'self-register' },
      }),
    ).rejects.toThrow();
    await expect(
      admin.membership.update({
        where: { id: membershipId },
        data: { roles: ['platform_operator'] },
      }),
    ).rejects.toThrow();
  });
  it('does not leak identity or tenant context when pooled connections are reused', async () => {
    const other = await admin.identity.create({
      data: {
        issuer: 'https://other.example/realm',
        subject: principal.subject,
      },
    });
    await admin.membership.create({
      data: { tenantId: tenantB, identityId: other.id, roles: ['hr_admin'] },
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const tenant = i % 2 ? tenantA : tenantB;
        const who = i % 2 ? principal : { ...principal, issuer: other.issuer };
        return inAuthorizedTenant(
          app,
          who,
          tenant,
          'employees.read',
          async (tx) => {
            expect((await tx.identity.findMany()).map((row) => row.id)).toEqual(
              [i % 2 ? identityId : other.id],
            );
            expect(
              (await tx.membership.findMany()).map((row) => row.tenantId),
            ).toEqual([tenant]);
          },
        );
      }),
    );
    expect(await app.identity.findMany()).toEqual([]);
    expect(await app.membership.findMany()).toEqual([]);
  });
});
