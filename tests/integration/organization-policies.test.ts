import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createOrganizationPolicyDraft,
  createTenantBranch,
  createTenantLegalEntity,
  previewOrganizationPolicy,
  publishOrganizationPolicy,
  readTenantOrganization,
  updateTenantBranch,
  updateTenantLegalEntity,
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
  throw new Error('Organization tests require synthetic kinto_test databases');

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
let tenantId: string;
let otherTenantId: string;
let identities: Record<'owner' | 'hr' | 'employee' | 'otherOwner', string>;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const karachiDate = (daysFromToday = 0) =>
  new Date(Date.now() + (5 * 60 * 60 + daysFromToday * 24 * 60 * 60) * 1000)
    .toISOString()
    .slice(0, 10);
const legalEntity = {
  legalName: 'Synthetic Private Limited',
  registrationNumber: '0123456',
  taxNumber: '1234567-8',
  provinceCode: 'PK-PB' as const,
  reason: 'Initial legal employer setup',
};
const branch = {
  code: 'LHR-01',
  name: 'Lahore Head Office',
  provinceCode: 'PK-PB' as const,
  reason: 'Initial operating branch',
};

describe('tenant organization and effective policy boundary', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    identities = {
      owner: randomUUID(),
      hr: randomUUID(),
      employee: randomUUID(),
      otherOwner: randomUUID(),
    };
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic organization tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: Object.entries(identities).map(([name, id]) => ({
        id,
        issuer: 'https://organization.synthetic.example/realm',
        subject: `${name}-${randomUUID()}`,
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: identities.owner, roles: ['owner'] },
        { tenantId, identityId: identities.hr, roles: ['hr_admin'] },
        { tenantId, identityId: identities.employee, roles: ['employee'] },
        {
          tenantId: otherTenantId,
          identityId: identities.otherOwner,
          roles: ['owner'],
        },
      ],
    });
  });

  afterEach(async () => {
    const tenants = [tenantId, otherTenantId];
    await admin.consumerReceipt.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.jobDelivery.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.outboxEvent.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.auditEvent.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.companyPolicyVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.branch.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.legalEntity.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.membership.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.tenant.deleteMany({ where: { id: { in: tenants } } });
    await admin.identity.deleteMany({
      where: { id: { in: Object.values(identities) } },
    });
  });

  afterAll(async () =>
    Promise.all([admin.$disconnect(), runtime.$disconnect()]),
  );

  it('allows recent-MFA owners and HR to read while denying employees and cross-tenant actors', async () => {
    const empty = {
      legalEntity: null,
      branches: [],
      latestPublishedVersion: 0,
      publishedPolicy: null,
      policyDrafts: [],
    };
    expect(
      await readTenantOrganization(runtime, actor(identities.owner), tenantId),
    ).toEqual(empty);
    expect(
      await readTenantOrganization(runtime, actor(identities.hr), tenantId),
    ).toEqual(empty);
    for (const caller of [
      actor(identities.employee),
      actor(identities.owner, false),
      actor(identities.otherOwner),
    ])
      await expect(
        readTenantOrganization(runtime, caller, tenantId),
      ).rejects.toThrow('FORBIDDEN');
  });

  it('creates exactly one fixed Pakistan legal employer with atomic audit and outbox', async () => {
    const result = await createTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      legalEntity,
    );
    expect(result).toEqual({ id: expect.any(String), version: 1 });
    expect(
      await readTenantOrganization(runtime, actor(identities.hr), tenantId),
    ).toMatchObject({
      legalEntity: {
        id: result.id,
        legalName: legalEntity.legalName,
        registrationNumber: legalEntity.registrationNumber,
        taxNumber: legalEntity.taxNumber,
        provinceCode: 'PK-PB',
        countryCode: 'PK',
        currencyCode: 'PKR',
        timeZone: 'Asia/Karachi',
        version: 1,
      },
    });
    await expect(
      createTenantLegalEntity(
        runtime,
        actor(identities.owner),
        tenantId,
        legalEntity,
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      createTenantLegalEntity(
        runtime,
        actor(identities.hr),
        otherTenantId,
        legalEntity,
      ),
    ).rejects.toThrow('FORBIDDEN');
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'legal_entity.created' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: 'legal_entity.created.v1' },
      }),
    ).toBe(1);
  });

  it('audits legal identity changes and enforces version and tenant boundaries', async () => {
    const created = await createTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      legalEntity,
    );
    const updated = await updateTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      created.id,
      {
        expectedVersion: 1,
        legalName: 'Synthetic Holdings Private Limited',
        registrationNumber: legalEntity.registrationNumber,
        taxNumber: legalEntity.taxNumber,
        provinceCode: 'PK-IS',
        reason: 'Approved legal identity correction',
      },
    );
    expect(updated.version).toBe(2);
    expect(
      await admin.auditEvent.findFirstOrThrow({
        where: {
          tenantId,
          action: 'legal_entity.updated',
          resourceId: created.id,
        },
      }),
    ).toMatchObject({
      actorId: identities.owner,
      reason: 'Approved legal identity correction',
    });
    await expect(
      updateTenantLegalEntity(
        runtime,
        actor(identities.owner),
        tenantId,
        created.id,
        {
          expectedVersion: 1,
          ...legalEntity,
        },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      updateTenantLegalEntity(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        created.id,
        {
          expectedVersion: 2,
          ...legalEntity,
        },
      ),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('creates tenant branches and protects an effective or future default from deactivation', async () => {
    await expect(
      createTenantBranch(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        branch,
      ),
    ).rejects.toThrow('INVALID_STATE');
    await createTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      legalEntity,
    );
    const created = await createTenantBranch(
      runtime,
      actor(identities.owner),
      tenantId,
      branch,
    );
    await expect(
      createTenantBranch(runtime, actor(identities.owner), tenantId, branch),
    ).rejects.toThrow('CONFLICT');
    expect(
      await updateTenantBranch(
        runtime,
        actor(identities.owner),
        tenantId,
        created.id,
        {
          expectedVersion: 1,
          code: 'LHR-HQ',
          name: branch.name,
          provinceCode: branch.provinceCode,
          status: 'active',
          reason: 'Use the approved branch code',
        },
      ),
    ).toEqual({ id: created.id, version: 2 });
    const draft = await createOrganizationPolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        expectedCurrentVersion: 0,
        effectiveFrom: karachiDate(),
        settings: { defaultBranchId: created.id },
        reason: 'Select the company default branch',
      },
    );
    await publishOrganizationPolicy(
      runtime,
      actor(identities.owner),
      tenantId,
      draft.id,
      {
        expectedVersion: draft.version,
        reason: 'Publish reviewed organization defaults',
      },
    );
    await expect(
      updateTenantBranch(
        runtime,
        actor(identities.owner),
        tenantId,
        created.id,
        {
          expectedVersion: 2,
          code: 'LHR-HQ',
          name: branch.name,
          provinceCode: branch.provinceCode,
          status: 'inactive',
          reason: 'Attempt to close the default branch',
        },
      ),
    ).rejects.toThrow('INVALID_STATE');
  });

  it('previews and publishes typed effective policy history without overwriting prior versions', async () => {
    await createTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      legalEntity,
    );
    const firstBranch = await createTenantBranch(
      runtime,
      actor(identities.owner),
      tenantId,
      branch,
    );
    const secondBranch = await createTenantBranch(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        ...branch,
        code: 'ISB-01',
        name: 'Islamabad Office',
        provinceCode: 'PK-IS',
      },
    );
    const first = await createOrganizationPolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        expectedCurrentVersion: 0,
        effectiveFrom: karachiDate(),
        settings: { defaultBranchId: firstBranch.id },
        reason: 'Initial organization defaults',
      },
    );
    expect(
      await previewOrganizationPolicy(
        runtime,
        actor(identities.hr),
        tenantId,
        first.id,
      ),
    ).toMatchObject({
      id: first.id,
      version: 1,
      basedOnVersion: 0,
      defaultBranch: { id: firstBranch.id, code: 'LHR-01' },
      affectedOpenPeriods: [],
    });
    await publishOrganizationPolicy(
      runtime,
      actor(identities.owner),
      tenantId,
      first.id,
      {
        expectedVersion: 1,
        reason: 'Publish initial organization defaults',
      },
    );
    const second = await createOrganizationPolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        expectedCurrentVersion: 1,
        effectiveFrom: karachiDate(1),
        settings: { defaultBranchId: secondBranch.id },
        reason: 'Schedule the new default branch',
      },
    );
    await publishOrganizationPolicy(
      runtime,
      actor(identities.owner),
      tenantId,
      second.id,
      {
        expectedVersion: 2,
        reason: 'Publish future organization defaults',
      },
    );
    const snapshot = await readTenantOrganization(
      runtime,
      actor(identities.owner),
      tenantId,
    );
    expect(snapshot.publishedPolicy).toMatchObject({
      id: first.id,
      version: 1,
      settings: { defaultBranchId: firstBranch.id },
    });
    expect(snapshot.latestPublishedVersion).toBe(2);
    expect(
      await admin.companyPolicyVersion.findMany({
        where: { tenantId, status: 'published' },
        orderBy: { policyVersion: 'asc' },
        select: { id: true, policyVersion: true, settings: true },
      }),
    ).toEqual([
      {
        id: first.id,
        policyVersion: 1,
        settings: { defaultBranchId: firstBranch.id },
      },
      {
        id: second.id,
        policyVersion: 2,
        settings: { defaultBranchId: secondBranch.id },
      },
    ]);
  });

  it('rejects stale publication, cross-tenant branch settings and direct runtime table access', async () => {
    await createTenantLegalEntity(
      runtime,
      actor(identities.owner),
      tenantId,
      legalEntity,
    );
    await createTenantLegalEntity(
      runtime,
      actor(identities.otherOwner),
      otherTenantId,
      legalEntity,
    );
    const localBranch = await createTenantBranch(
      runtime,
      actor(identities.owner),
      tenantId,
      branch,
    );
    const foreignBranch = await createTenantBranch(
      runtime,
      actor(identities.otherOwner),
      otherTenantId,
      branch,
    );
    await expect(
      createOrganizationPolicyDraft(
        runtime,
        actor(identities.owner),
        tenantId,
        {
          expectedCurrentVersion: 0,
          effectiveFrom: karachiDate(),
          settings: { defaultBranchId: foreignBranch.id },
          reason: 'Attempt cross-company default',
        },
      ),
    ).rejects.toThrow('CONFLICT');
    const first = await createOrganizationPolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        expectedCurrentVersion: 0,
        effectiveFrom: karachiDate(),
        settings: { defaultBranchId: localBranch.id },
        reason: 'First concurrent proposal',
      },
    );
    const stale = await createOrganizationPolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      {
        expectedCurrentVersion: 0,
        effectiveFrom: karachiDate(1),
        settings: { defaultBranchId: localBranch.id },
        reason: 'Second concurrent proposal',
      },
    );
    await publishOrganizationPolicy(
      runtime,
      actor(identities.owner),
      tenantId,
      first.id,
      {
        expectedVersion: first.version,
        reason: 'Publish the selected proposal',
      },
    );
    await expect(
      publishOrganizationPolicy(
        runtime,
        actor(identities.owner),
        tenantId,
        stale.id,
        {
          expectedVersion: stale.version,
          reason: 'Reject stale proposal',
        },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(runtime.legalEntity.findMany()).rejects.toThrow();
    await expect(runtime.branch.findMany()).rejects.toThrow();
    await expect(runtime.companyPolicyVersion.findMany()).rejects.toThrow();
  });
});
