import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OrganizationController } from '../../apps/api/src/organization/controller';
import { DatabaseService } from '../../apps/api/src/database.service';
import { AuthService } from '../../apps/api/src/auth/service';
import { configureHttp } from '../../apps/api/src/http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCompanyLeaveType,
  createCompanyLeavePolicyDraft,
  publishCompanyLeavePolicy,
  listCompanyLeaveTypes,
  listCompanyLeavePolicies,
  createAttendanceTimingPolicyDraft,
  publishAttendanceTimingPolicy,
  listAttendanceTimingPolicies,
  previewAttendanceTimingPolicy,
  createDatabase,
  createOrganizationPolicyDraft,
  createTenantBranch,
  createTenantLegalEntity,
  createTenantOrganizationCatalogEntry,
  previewOrganizationPolicy,
  publishOrganizationPolicy,
  readTenantOrganization,
  updateTenantBranch,
  updateTenantLegalEntity,
  updateTenantOrganizationCatalogEntry,
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
    await admin.leavePolicyReceipt.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.leavePolicyVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.leaveType.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.attendanceTimingReceipt.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.companyPolicyVersion.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await admin.department.deleteMany({ where: { tenantId: { in: tenants } } });
    await admin.designation.deleteMany({
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
      departments: [],
      designations: [],
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

  it('versions tenant-scoped department and designation catalogs with owner-only writes', async () => {
    const department = await createTenantOrganizationCatalogEntry(
      runtime,
      actor(identities.owner),
      tenantId,
      'department',
      {
        code: ' eng ',
        name: ' Engineering ',
        reason: 'Create the engineering department',
      },
    );
    const designation = await createTenantOrganizationCatalogEntry(
      runtime,
      actor(identities.owner),
      tenantId,
      'designation',
      {
        code: 'swe',
        name: 'Software Engineer',
        reason: 'Create the engineering designation',
      },
    );
    expect(
      await readTenantOrganization(runtime, actor(identities.hr), tenantId),
    ).toMatchObject({
      departments: [
        { id: department.id, code: 'ENG', name: 'Engineering', version: 1 },
      ],
      designations: [
        {
          id: designation.id,
          code: 'SWE',
          name: 'Software Engineer',
          version: 1,
        },
      ],
    });
    expect(
      await updateTenantOrganizationCatalogEntry(
        runtime,
        actor(identities.owner),
        tenantId,
        'department',
        department.id,
        {
          expectedVersion: 1,
          code: 'ENG',
          name: 'Product Engineering',
          status: 'inactive',
          reason: 'Merge the department structure',
        },
      ),
    ).toEqual({ id: department.id, version: 2 });
    await expect(
      updateTenantOrganizationCatalogEntry(
        runtime,
        actor(identities.owner),
        tenantId,
        'department',
        department.id,
        {
          expectedVersion: 1,
          code: 'ENG',
          name: 'Stale update',
          status: 'active',
          reason: 'Attempt stale catalog update',
        },
      ),
    ).rejects.toThrow('STALE_VERSION');
    await expect(
      updateTenantOrganizationCatalogEntry(
        runtime,
        actor(identities.owner),
        tenantId,
        'designation',
        designation.id,
        {
          expectedVersion: 1,
          code: 'SWE',
          name: 'Software Engineer',
          status: 'active',
          reason: 'Attempt a no-op catalog update',
        },
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      updateTenantOrganizationCatalogEntry(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        'department',
        department.id,
        {
          expectedVersion: 2,
          code: 'ENG',
          name: 'Foreign update',
          status: 'active',
          reason: 'Attempt a cross-tenant update',
        },
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      createTenantOrganizationCatalogEntry(
        runtime,
        actor(identities.hr),
        tenantId,
        'department',
        {
          code: 'HR',
          name: 'Human Resources',
          reason: 'Unauthorized catalog write',
        },
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(runtime.department.findMany()).rejects.toThrow();
    expect(
      await admin.auditEvent.findMany({
        where: { tenantId, resourceId: department.id },
        orderBy: { createdAt: 'asc' },
        select: { action: true, reason: true },
      }),
    ).toEqual([
      {
        action: 'department.created',
        reason: 'Create the engineering department',
      },
      {
        action: 'department.updated',
        reason: 'Merge the department structure',
      },
    ]);
    expect(
      await admin.outboxEvent.count({
        where: {
          tenantId,
          aggregateId: department.id,
          type: { in: ['department.created.v1', 'department.updated.v1'] },
        },
      }),
    ).toBe(2);
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
  const timing = {
    scope: 'company',
    timeZone: 'Asia/Karachi',
    checkIn: '22:00',
    checkOut: '06:00',
    checkOutNextDay: true,
    breakMode: 'fixed_duration',
    unpaidBreakMinutes: 30,
    fullDayTargetMinutes: 450,
    halfDayTargetMinutes: 225,
    minimumFullDayMinutes: 420,
    minimumHalfDayMinutes: 180,
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    associationBeforeMinutes: 30,
    associationAfterMinutes: 60,
    weeklyRestDays: [7],
  };
  const timingInput = (days = 0, version = 0) => ({
    expectedCurrentVersion: version,
    effectiveFrom: karachiDate(days),
    settings: timing,
    reason: 'Reviewed synthetic timing policy',
  });
  const draftTiming = (days = 0, version = 0, key = randomUUID()) =>
    createAttendanceTimingPolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      key,
      timingInput(days, version),
    );
  const publishTiming = (
    p: { id: string; version: number },
    key = randomUUID(),
  ) =>
    publishAttendanceTimingPolicy(
      runtime,
      actor(identities.owner),
      tenantId,
      p.id,
      key,
      { expectedVersion: p.version, reason: 'Reviewed timing publication' },
    );
  it('publishes immutable timing versions and resolves effective history independently from organization defaults', async () => {
    const key = randomUUID(),
      input = timingInput(),
      draft = await draftTiming(0, 0, key);
    expect(
      await createAttendanceTimingPolicyDraft(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        input,
      ),
    ).toEqual({ ...draft, replayed: true });
    const preview = await previewAttendanceTimingPolicy(
      runtime,
      actor(identities.hr),
      tenantId,
      draft.id,
    );
    expect(preview).toMatchObject({
      tenantId,
      scheduledMinutes: 480,
      netScheduledMinutes: 450,
      attendanceProcessingAvailable: false,
      payrollEffectsAvailable: false,
      policy: { id: draft.id, status: 'draft' },
    });
    expect(
      (
        await listAttendanceTimingPolicies(
          runtime,
          actor(identities.hr),
          tenantId,
        )
      ).currentPolicy,
    ).toBeNull();
    const publishKey = randomUUID(),
      published = await publishTiming(draft, publishKey);
    expect(await publishTiming(draft, publishKey)).toEqual({
      ...published,
      replayed: true,
    });
    const second = await draftTiming(5, draft.version);
    await publishTiming(second);
    const today = await listAttendanceTimingPolicies(
      runtime,
      actor(identities.owner),
      tenantId,
      { asOf: karachiDate() },
    );
    expect(today.latestPublishedVersion).toBe(second.version);
    expect(today.currentPolicy?.id).toBe(draft.id);
    expect(
      (
        await listAttendanceTimingPolicies(
          runtime,
          actor(identities.owner),
          tenantId,
          { asOf: karachiDate(5) },
        )
      ).currentPolicy?.id,
    ).toBe(second.id);
    expect(
      (
        await listAttendanceTimingPolicies(
          runtime,
          actor(identities.owner),
          tenantId,
          { asOf: karachiDate(-1) },
        )
      ).currentPolicy,
    ).toBeNull();
    expect(
      (await readTenantOrganization(runtime, actor(identities.owner), tenantId))
        .latestPublishedVersion,
    ).toBe(0);
    expect(
      await createAttendanceTimingPolicyDraft(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        input,
      ),
    ).toEqual({ ...draft, replayed: true });
  });
  it('rechecks owner/HR authority and denies unauthorized timing reads, writes and exact retries', async () => {
    const key = randomUUID(),
      p = await draftTiming(0, 0, key);
    for (const caller of [
      actor(identities.employee),
      actor(identities.otherOwner),
      actor(identities.owner, false),
    ]) {
      await expect(
        listAttendanceTimingPolicies(runtime, caller, tenantId),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        previewAttendanceTimingPolicy(runtime, caller, tenantId, p.id),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        createAttendanceTimingPolicyDraft(
          runtime,
          caller,
          tenantId,
          randomUUID(),
          timingInput(),
        ),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        publishAttendanceTimingPolicy(
          runtime,
          caller,
          tenantId,
          p.id,
          randomUUID(),
          { expectedVersion: p.version, reason: 'denied timing publication' },
        ),
      ).rejects.toThrow('FORBIDDEN');
    }
    await expect(
      createAttendanceTimingPolicyDraft(
        runtime,
        actor(identities.hr),
        tenantId,
        randomUUID(),
        timingInput(),
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      previewAttendanceTimingPolicy(
        runtime,
        actor(identities.owner),
        otherTenantId,
        p.id,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      previewAttendanceTimingPolicy(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
      ),
    ).rejects.toThrow('NOT_FOUND');
    await admin.membership.updateMany({
      where: { tenantId, identityId: identities.owner },
      data: { status: 'revoked' },
    });
    await expect(
      createAttendanceTimingPolicyDraft(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        timingInput(),
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('serializes concurrent timing commands and rejects changed keyed requests without extra facts', async () => {
    const key = randomUUID();
    const replies = await Promise.all([
      draftTiming(0, 0, key),
      draftTiming(0, 0, key),
    ]);
    expect(replies[0].id).toBe(replies[1].id);
    expect(replies.map((v) => v.replayed).sort()).toEqual([false, true]);
    expect(await admin.auditEvent.count({ where: { tenantId } })).toBe(1);
    expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(1);
    await expect(
      createAttendanceTimingPolicyDraft(
        runtime,
        actor(identities.owner),
        tenantId,
        key,
        { ...timingInput(), reason: 'different approved reason' },
      ),
    ).rejects.toThrow('CONFLICT');
    const second = await draftTiming(1);
    const publications = await Promise.allSettled([
      publishTiming(replies[0]),
      publishTiming(second),
    ]);
    expect(publications.filter((v) => v.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(publications.filter((v) => v.status === 'rejected')).toHaveLength(1);
    expect(
      await admin.companyPolicyVersion.count({
        where: { tenantId, domain: 'attendance_timing', status: 'published' },
      }),
    ).toBe(1);
  });
  it('rejects backdates, stale bases, expired drafts and insertion before future published schedules', async () => {
    await expect(draftTiming(-1)).rejects.toThrow('CONFLICT');
    const first = await draftTiming(0),
      stale = await draftTiming(1);
    await publishTiming(first);
    await expect(publishTiming(stale)).rejects.toThrow('STALE_VERSION');
    await expect(draftTiming(1, 0)).rejects.toThrow('STALE_VERSION');
    const future = await draftTiming(5, first.version);
    await publishTiming(future);
    await expect(draftTiming(4, future.version)).rejects.toThrow('CONFLICT');
    const expired = await draftTiming(6, future.version);
    await admin.companyPolicyVersion.update({
      where: { id: expired.id },
      data: { effectiveFrom: new Date(karachiDate(-1)) },
    });
    await expect(publishTiming(expired)).rejects.toThrow('CONFLICT');
  });
  it('validates SQL timing settings without allowing direct-runtime JSON bypasses', async () => {
    for (const settings of [
      { ...timing, minimumHalfDayMinutes: 500 },
      { ...timing, checkOutNextDay: false },
      { ...timing, unpaidBreakMinutes: 480 },
      { ...timing, weeklyRestDays: [7, 7] },
      { ...timing, scope: 'employee' },
      { ...timing, branchId: randomUUID() },
      { ...timing, lateGraceMinutes: '10' },
      { ...timing, minimumHalfDayMinutes: null },
    ]) {
      const [row] = await runtime.$queryRaw<
        { outcome: string }[]
      >`SELECT * FROM public.mutate_attendance_timing_policy(${identities.owner}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,'create'::varchar,NULL::uuid,0::integer,${karachiDate()}::date,${JSON.stringify(settings)}::jsonb,'SQL bypass attempt'::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
      expect(row.outcome).toBe('invalid_state');
      await expect(
        admin.companyPolicyVersion.create({
          data: {
            id: randomUUID(),
            tenantId,
            domain: 'attendance_timing',
            policyVersion: 1,
            basedOnVersion: 0,
            effectiveFrom: new Date(karachiDate()),
            settings,
            reason: 'Rejected direct invalid row',
            createdByIdentityId: identities.owner,
          },
        }),
      ).rejects.toThrow();
    }
    expect(
      await admin.companyPolicyVersion.count({ where: { tenantId } }),
    ).toBe(0);
  });
  it('rolls back timing policy, receipt and outbox when atomic audit insertion fails', async () => {
    const initial = await draftTiming(),
      audit = await admin.auditEvent.findFirstOrThrow({ where: { tenantId } }),
      key = randomUUID();
    await expect(
      runtime.$queryRaw`SELECT * FROM public.mutate_attendance_timing_policy(${identities.owner}::uuid,true,${tenantId}::uuid,${key}::uuid,'create'::varchar,NULL::uuid,0::integer,${karachiDate(1)}::date,${JSON.stringify(timing)}::jsonb,'Audit rollback fixture'::varchar,${audit.id}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow();
    expect(
      await admin.companyPolicyVersion.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.attendanceTimingReceipt.count({ where: { tenantId } }),
    ).toBe(1);
    expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(1);
    expect(initial.version).toBe(1);
  });
  it('keeps timing receipts private and timing mutation functions constrained', async () => {
    await draftTiming();
    await expect(runtime.attendanceTimingReceipt.findMany()).rejects.toThrow(
      'permission denied',
    );
    const [row] = await admin.$queryRaw<
      { safe: boolean }[]
    >`SELECT bool_and(p.prosecdef AND r.rolname='kinto_control_owner' AND NOT has_function_privilege('kinto_worker',p.oid,'EXECUTE') AND NOT has_function_privilege('kinto_dispatcher',p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')) AS safe FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('read_attendance_timing_policies','read_attendance_timing_policy','mutate_attendance_timing_policy')`;
    expect(row.safe).toBe(true);
  });
  it('protects published timing history against control-role updates and cross-domain publication', async () => {
    const p = await draftTiming();
    await publishTiming(p);
    await expect(
      admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL SESSION AUTHORIZATION kinto_control_owner',
        );
        await tx.$executeRaw`UPDATE public.company_policy_versions SET reason='changed history' WHERE id=${p.id}::uuid`;
      }),
    ).rejects.toThrow('immutable');
    await expect(
      publishOrganizationPolicy(
        runtime,
        actor(identities.owner),
        tenantId,
        p.id,
        { expectedVersion: p.version, reason: 'Cross-domain attempt' },
      ),
    ).rejects.toThrow();
  });
  it('paginates bounded timing history without resolving from the displayed page', async () => {
    const p = await draftTiming();
    await publishTiming(p);
    await draftTiming(5, p.version);
    const first = await listAttendanceTimingPolicies(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 1 },
    );
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0].id);
    const next = await listAttendanceTimingPolicies(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 1, afterId: first.nextCursor },
    );
    expect(next.nextCursor).toBeNull();
    expect(next.items[0].id).not.toBe(first.items[0].id);
    expect(next.currentPolicy?.id).toBe(p.id);
  });
  it('runs timing policy HTTP publication through real SQL and fresh server session boundaries', async () => {
    const csrf = 'c'.repeat(43),
      origin = 'https://timing.synthetic.example';
    let identityId = identities.owner,
      selectedTenantId = tenantId,
      authTime = Math.floor(Date.now() / 1000);
    const module = await Test.createTestingModule({
      controllers: [OrganizationController],
      providers: [
        DatabaseService,
        {
          provide: AuthService,
          useValue: {
            limit: async () => {},
            origin: () => origin,
            session: async () => ({
              identityId,
              selectedTenantId,
              authTime,
              csrf,
              principal: { mfaVerified: true },
            }),
          },
        },
      ],
    }).compile();
    const application = module.createNestApplication();
    configureHttp(application);
    try {
      await application.listen(0, '127.0.0.1');
      const base = `/api/v1/tenants/${tenantId}/organization/policies/attendance-timing`,
        key = randomUUID();
      const post = (path: string, requestId: string) =>
        request(application.getHttpServer())
          .post(base + path)
          .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
          .set('Origin', origin)
          .set('X-CSRF-Token', csrf)
          .set('Idempotency-Key', requestId);
      const get = (path = '') =>
        request(application.getHttpServer())
          .get(base + path)
          .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43));
      const created = await post('/drafts', key)
        .send(timingInput())
        .expect(201);
      expect(
        (await post('/drafts', key).send(timingInput()).expect(201)).body,
      ).toEqual({ ...created.body, replayed: true });
      identityId = identities.hr;
      expect(
        (await get('/' + created.body.id + '/preview').expect(200)).body
          .netScheduledMinutes,
      ).toBe(450);
      const publicationKey = randomUUID(),
        body = {
          expectedVersion: created.body.version,
          reason: 'HTTP reviewed publication',
        };
      await post('/' + created.body.id + '/publication', publicationKey)
        .send(body)
        .expect(403);
      identityId = identities.owner;
      authTime = 1;
      await post('/' + created.body.id + '/publication', publicationKey)
        .send(body)
        .expect(403);
      authTime = Math.floor(Date.now() / 1000);
      selectedTenantId = otherTenantId;
      await get().expect(403);
      selectedTenantId = tenantId;
      await post('/' + created.body.id + '/publication', publicationKey)
        .send(body)
        .expect(201);
      const list = await get().expect(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(list.body.currentPolicy.id).toBe(created.body.id);
      expect(list.body.attendanceProcessingAvailable).toBe(false);
    } finally {
      await application.close();
    }
  });
  const leaveSettings = {
    scope: 'company',
    timeZone: 'Asia/Karachi',
    code: 'CASUAL',
    name: 'Casual leave',
    pay: 'paid',
    grantMode: 'annual_upfront',
    annualQuotaDays: 12,
    monthlyQuotaDays: 2,
    leaveYearStart: { month: 1, day: 1 },
    nonWorkingDays: 'exclude',
  };
  const leaveInput = (days = 0, version = 0, settings = leaveSettings) => ({
    expectedCurrentVersion: version,
    effectiveFrom: karachiDate(days),
    settings,
    reason: 'Employer-reviewed synthetic leave limits',
  });
  const createLeave = (key = randomUUID()) =>
    createCompanyLeaveType(
      runtime,
      actor(identities.owner),
      tenantId,
      key,
      leaveInput(),
    );
  const publishLeave = (
    p: { leaveTypeId: string; id: string; version: number },
    key = randomUUID(),
  ) =>
    publishCompanyLeavePolicy(
      runtime,
      actor(identities.owner),
      tenantId,
      p.leaveTypeId,
      p.id,
      key,
      {
        expectedVersion: p.version,
        reason: 'Reviewed company-wide leave publication',
      },
    );
  it('publishes leave limits by type and resolves full effective history independently of the displayed page', async () => {
    const first = await createLeave();
    const initial = await listCompanyLeavePolicies(
      runtime,
      actor(identities.hr),
      tenantId,
      first.leaveTypeId,
    );
    expect(initial.currentPolicy).toBeNull();
    expect(initial.leaveReservationAvailable).toBe(false);
    await publishLeave(first);
    const future = await createCompanyLeavePolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      first.leaveTypeId,
      randomUUID(),
      leaveInput(10, first.version, {
        ...leaveSettings,
        monthlyQuotaDays: 1.5,
      }),
    );
    await publishLeave(future);
    const state = await listCompanyLeavePolicies(
      runtime,
      actor(identities.hr),
      tenantId,
      first.leaveTypeId,
      { limit: 1 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.currentPolicy?.id).toBe(first.id);
    expect(state.currentPolicy?.effectiveUntil).toBe(karachiDate(10));
    expect(state.latestPublishedVersion).toBe(future.version);
    expect(state.payrollEffectsAvailable).toBe(false);
    const later = await listCompanyLeavePolicies(
      runtime,
      actor(identities.owner),
      tenantId,
      first.leaveTypeId,
      { asOf: karachiDate(10), limit: 1, afterId: state.nextCursor! },
    );
    expect(later.currentPolicy?.id).toBe(future.id);
    expect(later.currentPolicy?.settings.monthlyQuotaDays).toBe(1.5);
    expect(later.currentPolicy?.effectiveUntil).toBeNull();
    const unpaid = await createCompanyLeaveType(
      runtime,
      actor(identities.owner),
      tenantId,
      randomUUID(),
      leaveInput(0, 0, {
        ...leaveSettings,
        code: 'UNPAID',
        name: 'Unpaid leave',
        pay: 'unpaid',
      }),
    );
    await publishLeave(unpaid);
    const catalog = await listCompanyLeaveTypes(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 1 },
    );
    expect(catalog.items).toHaveLength(1);
    expect(catalog.nextCursor).toBe(catalog.items[0].id);
    const remaining = await listCompanyLeaveTypes(
      runtime,
      actor(identities.hr),
      tenantId,
      { limit: 1, afterId: catalog.nextCursor! },
    );
    expect(remaining.nextCursor).toBeNull();
    expect(remaining.items[0].id).not.toBe(catalog.items[0].id);
  });
  it('rechecks leave owner authority before receipt replay and denies cross-company or employee access', async () => {
    const key = randomUUID(),
      first = await createLeave(key);
    for (const caller of [
      actor(identities.employee),
      actor(identities.otherOwner),
      actor(identities.owner, false),
    ]) {
      await expect(
        listCompanyLeaveTypes(runtime, caller, tenantId),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        listCompanyLeavePolicies(runtime, caller, tenantId, first.leaveTypeId),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        createCompanyLeaveType(runtime, caller, tenantId, key, leaveInput()),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        publishCompanyLeavePolicy(
          runtime,
          caller,
          tenantId,
          first.leaveTypeId,
          first.id,
          randomUUID(),
          { expectedVersion: first.version, reason: 'Denied publication' },
        ),
      ).rejects.toThrow('FORBIDDEN');
    }
    await expect(
      createCompanyLeavePolicyDraft(
        runtime,
        actor(identities.hr),
        tenantId,
        first.leaveTypeId,
        randomUUID(),
        leaveInput(),
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      listCompanyLeavePolicies(
        runtime,
        actor(identities.owner),
        tenantId,
        randomUUID(),
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      listCompanyLeavePolicies(
        runtime,
        actor(identities.otherOwner),
        otherTenantId,
        first.leaveTypeId,
      ),
    ).rejects.toThrow('NOT_FOUND');
    await admin.membership.updateMany({
      where: { tenantId, identityId: identities.owner },
      data: { status: 'revoked' },
    });
    await expect(createLeave(key)).rejects.toThrow('FORBIDDEN');
  });
  it('serializes exact leave retries and competing publications without duplicate facts', async () => {
    const key = randomUUID();
    const replies = await Promise.all([createLeave(key), createLeave(key)]);
    expect(replies[0].id).toBe(replies[1].id);
    expect(replies.filter((r) => r.replayed)).toHaveLength(1);
    await expect(
      createCompanyLeaveType(runtime, actor(identities.owner), tenantId, key, {
        ...leaveInput(),
        reason: 'Changed retry payload',
      }),
    ).rejects.toThrow('CONFLICT');
    await expect(createLeave()).rejects.toThrow('CONFLICT');
    const second = await createCompanyLeavePolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      replies[0].leaveTypeId,
      randomUUID(),
      leaveInput(1),
    );
    const attempts = await Promise.allSettled([
      publishLeave(replies[0]),
      publishLeave(second),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await admin.leavePolicyVersion.count({
        where: { tenantId, status: 'published' },
      }),
    ).toBe(1);
    expect(await admin.leavePolicyReceipt.count({ where: { tenantId } })).toBe(
      3,
    );
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: { startsWith: 'leave_policy.' } },
      }),
    ).toBe(3);
    expect(
      await admin.outboxEvent.count({
        where: { tenantId, type: { startsWith: 'leave_policy.' } },
      }),
    ).toBe(3);
  });
  it('refuses backdating, immutable type code and unreconciled leave-year changes', async () => {
    const first = await createLeave();
    await publishLeave(first);
    for (const input of [
      leaveInput(-1, first.version),
      leaveInput(0, first.version),
      leaveInput(1, 0),
      leaveInput(1, first.version, { ...leaveSettings, code: 'ANNUAL' }),
      leaveInput(1, first.version, {
        ...leaveSettings,
        leaveYearStart: { month: 4, day: 1 },
      }),
    ]) {
      await expect(
        createCompanyLeavePolicyDraft(
          runtime,
          actor(identities.owner),
          tenantId,
          first.leaveTypeId,
          randomUUID(),
          input,
        ),
      ).rejects.toThrow(/CONFLICT|STALE_VERSION/);
    }
    const staleDraft = await createCompanyLeavePolicyDraft(
      runtime,
      actor(identities.owner),
      tenantId,
      first.leaveTypeId,
      randomUUID(),
      leaveInput(1, first.version),
    );
    await admin.leavePolicyVersion.update({
      where: { id: staleDraft.id },
      data: { effectiveFrom: new Date(karachiDate(-1)) },
    });
    await expect(publishLeave(staleDraft)).rejects.toThrow('CONFLICT');
    await expect(
      admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL SESSION AUTHORIZATION kinto_control_owner',
        );
        await tx.leavePolicyVersion.update({
          where: { id: first.id },
          data: { settings: { ...leaveSettings, monthlyQuotaDays: 10 } },
        });
      }),
    ).rejects.toThrow('immutable');
    await expect(
      admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL SESSION AUTHORIZATION kinto_control_owner',
        );
        await tx.leavePolicyVersion.update({
          where: { id: staleDraft.id },
          data: { reason: 'Changed draft' },
        });
      }),
    ).rejects.toThrow('Only leave publication');
    await expect(
      admin.leavePolicyVersion.create({
        data: {
          id: randomUUID(),
          tenantId: otherTenantId,
          leaveTypeId: first.leaveTypeId,
          policyVersion: 1,
          basedOnVersion: 0,
          effectiveFrom: new Date(karachiDate()),
          settings: leaveSettings,
          reason: 'Cross tenant FK attempt',
          createdByIdentityId: identities.otherOwner,
        },
      }),
    ).rejects.toThrow();
  });
  it('validates leave settings inside SQL and rolls back type, policy, receipt and outbox on audit failure', async () => {
    for (const settings of [
      { ...leaveSettings, name: '\t' },
      { ...leaveSettings, name: '\u00a0Casual leave' },
      { ...leaveSettings, annualQuotaDays: 1.25 },
      { ...leaveSettings, monthlyQuotaDays: 32 },
      { ...leaveSettings, monthlyQuotaDays: '2' },
      { ...leaveSettings, leaveYearStart: { month: 2, day: 29 } },
      { ...leaveSettings, scope: 'employee' },
      { ...leaveSettings, employeeId: randomUUID() },
      { ...leaveSettings, pay: null },
      { ...leaveSettings, grantMode: 'monthly_accrual' },
    ]) {
      const rows = await runtime.$queryRaw<
        { outcome: string }[]
      >`SELECT * FROM public.mutate_company_leave_policy(${identities.owner}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,'create_type'::varchar,NULL::uuid,NULL::uuid,0::integer,${karachiDate()}::date,${JSON.stringify(settings)}::jsonb,'SQL validation attempt'::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
      expect(rows[0].outcome).toBe('invalid_state');
    }
    const audit = await admin.auditEvent.create({
      data: {
        id: randomUUID(),
        tenantId,
        actorId: identities.owner,
        action: 'fixture',
        resourceId: randomUUID(),
        reason: 'Duplicate audit rollback fixture',
      },
    });
    await expect(
      runtime.$queryRaw`SELECT * FROM public.mutate_company_leave_policy(${identities.owner}::uuid,true,${tenantId}::uuid,${randomUUID()}::uuid,'create_type'::varchar,NULL::uuid,NULL::uuid,0::integer,${karachiDate()}::date,${JSON.stringify(leaveSettings)}::jsonb,'Atomic rollback fixture'::varchar,${audit.id}::uuid,${randomUUID()}::uuid)`,
    ).rejects.toThrow();
    expect(await admin.leaveType.count({ where: { tenantId } })).toBe(0);
    expect(await admin.leavePolicyVersion.count({ where: { tenantId } })).toBe(
      0,
    );
    expect(await admin.leavePolicyReceipt.count({ where: { tenantId } })).toBe(
      0,
    );
    expect(await admin.outboxEvent.count({ where: { tenantId } })).toBe(0);
  });
  it('keeps leave policies and receipts private behind constrained functions', async () => {
    for (const table of [
      'leave_types',
      'leave_policy_versions',
      'leave_policy_receipts',
    ])
      await expect(
        runtime.$queryRawUnsafe(`SELECT * FROM public.${table}`),
      ).rejects.toThrow('permission denied');
    const rows = await admin.$queryRaw<
      { safe: boolean }[]
    >`SELECT bool_and(p.prosecdef AND r.rolname='kinto_control_owner' AND NOT has_function_privilege('kinto_worker',p.oid,'EXECUTE') AND NOT has_function_privilege('kinto_dispatcher',p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')) AS safe FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('read_company_leave_policies','mutate_company_leave_policy')`;
    expect(rows[0].safe).toBe(true);
    await expect(
      runtime.$queryRaw`SELECT public.valid_leave_policy_settings(${JSON.stringify(leaveSettings)}::jsonb)`,
    ).rejects.toThrow('permission denied');
  });
  it('runs leave publication HTTP through strict inputs, selected-company CSRF and fresh session authority', async () => {
    const csrf = 'c'.repeat(43),
      origin = 'https://leave.synthetic.example';
    let identityId = identities.owner,
      selectedTenantId = tenantId,
      authTime = Math.floor(Date.now() / 1000);
    const module = await Test.createTestingModule({
      controllers: [OrganizationController],
      providers: [
        DatabaseService,
        {
          provide: AuthService,
          useValue: {
            limit: async () => {},
            origin: () => origin,
            session: async () => ({
              identityId,
              selectedTenantId,
              authTime,
              csrf,
              principal: { mfaVerified: true },
            }),
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    configureHttp(app);
    await app.init();
    const base = `/api/v1/tenants/${tenantId}/organization/leave-types`;
    const post = (path: string, key = randomUUID()) =>
      request(app.getHttpServer())
        .post(base + path)
        .set('Cookie', `__Host-kinto-session=${'s'.repeat(43)}`)
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', key);
    const get = (path = '') =>
      request(app.getHttpServer())
        .get(base + path)
        .set('Cookie', `__Host-kinto-session=${'s'.repeat(43)}`);
    try {
      await request(app.getHttpServer()).get(base).expect(401);
      await get('?identityId=' + identities.owner).expect(400);
      await get('?asOf=0000-01-01').expect(400);
      await post('')
        .send({ ...leaveInput(), identityId: identities.owner })
        .expect(400);
      await post('')
        .set('Origin', 'https://wrong.example')
        .send(leaveInput())
        .expect(403);
      const key = randomUUID(),
        first = (await post('', key).send(leaveInput()).expect(201)).body;
      expect((await post('', key).send(leaveInput()).expect(201)).body).toEqual(
        { ...first, replayed: true },
      );
      const path = `/${first.leaveTypeId}/policies/${first.id}/publication`,
        body = {
          expectedVersion: first.version,
          reason: 'HTTP reviewed publication',
        };
      identityId = identities.hr;
      await post(path).send(body).expect(403);
      identityId = identities.owner;
      authTime = 1;
      await post(path).send(body).expect(403);
      authTime = Math.floor(Date.now() / 1000);
      selectedTenantId = otherTenantId;
      await get().expect(403);
      selectedTenantId = tenantId;
      await post(path).send(body).expect(201);
      const state = await get(`/${first.leaveTypeId}/policies`).expect(200);
      expect(state.body.currentPolicy.id).toBe(first.id);
      expect(state.body.leaveReservationAvailable).toBe(false);
      expect(state.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
