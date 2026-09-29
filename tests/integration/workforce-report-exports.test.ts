import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeTenantWorkforceReportExportDownload,
  createDatabase,
  createTenantWorkforceReportExport,
  readTenantWorkforceReportExport,
} from '@kinto/database';
import { processEvent } from '../../apps/worker/src/processor';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
if (
  !adminUrl ||
  !runtimeUrl ||
  !workerUrl ||
  [adminUrl, runtimeUrl, workerUrl].some(
    (url) => !new URL(url).pathname.startsWith('/kinto_test'),
  )
)
  throw new Error(
    'Workforce export tests require synthetic kinto_test databases',
  );

const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const worker = createDatabase(workerUrl);
let tenantId: string;
let otherTenantId: string;
let ownerId: string;
let employeeIdentityId: string;
let otherOwnerId: string;
const actor = (identityId: string, mfaVerified = true) => ({
  identityId,
  mfaVerified,
});
const parameters = {
  asOf: '2026-09-25',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
};
const input = {
  kind: 'workforce_headcount_csv' as const,
  parameters,
  reason: 'Monthly workforce export review',
};
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

async function createFixture() {
  const legalEntityId = randomUUID();
  const branchId = randomUUID();
  const departmentId = randomUUID();
  const designationId = randomUUID();
  const employeeId = randomUUID();
  const periodId = randomUUID();
  await admin.legalEntity.create({
    data: {
      id: legalEntityId,
      tenantId,
      legalName: 'Synthetic Export Private Limited',
      provinceCode: 'PK-PB',
    },
  });
  await admin.branch.create({
    data: {
      id: branchId,
      tenantId,
      legalEntityId,
      code: 'LHR',
      name: 'Lahore',
      provinceCode: 'PK-PB',
    },
  });
  await admin.department.create({
    data: {
      id: departmentId,
      tenantId,
      code: 'ENG',
      name: 'Engineering, North',
    },
  });
  await admin.designation.create({
    data: {
      id: designationId,
      tenantId,
      code: 'SWE',
      name: 'Software Engineer',
    },
  });
  await admin.employee.create({
    data: {
      id: employeeId,
      tenantId,
      employeeNumber: 'EMP-001',
      name: 'Synthetic Employee',
      joiningDate: day('2026-09-01'),
      employmentType: 'monthly_salaried',
      status: 'active',
    },
  });
  await admin.employmentPeriod.create({
    data: {
      id: periodId,
      tenantId,
      employeeId,
      periodNumber: 1,
      joiningDate: day('2026-09-01'),
      status: 'active',
    },
  });
  await admin.employeeAssignment.create({
    data: {
      id: randomUUID(),
      tenantId,
      employeeId,
      employmentPeriodId: periodId,
      branchId,
      departmentId,
      designationId,
      topLevelReason: 'Synthetic top-level role',
      effectiveFrom: day('2026-09-01'),
      createdByIdentityId: ownerId,
    },
  });
}

describe('asynchronous workforce report exports', () => {
  beforeEach(async () => {
    tenantId = randomUUID();
    otherTenantId = randomUUID();
    ownerId = randomUUID();
    employeeIdentityId = randomUUID();
    otherOwnerId = randomUUID();
    await admin.tenant.createMany({
      data: [tenantId, otherTenantId].map((id) => ({
        id,
        name: 'Synthetic export tenant',
        employeeLimit: 20,
      })),
    });
    await admin.identity.createMany({
      data: [ownerId, employeeIdentityId, otherOwnerId].map((id) => ({
        id,
        issuer: 'https://exports.synthetic.example/realm',
        subject: randomUUID(),
      })),
    });
    await admin.membership.createMany({
      data: [
        { tenantId, identityId: ownerId, roles: ['owner'] },
        { tenantId, identityId: employeeIdentityId, roles: ['employee'] },
        { tenantId: otherTenantId, identityId: otherOwnerId, roles: ['owner'] },
      ],
    });
    await createFixture();
  });

  afterEach(async () => {
    const tenants = [tenantId, otherTenantId];
    const where = { tenantId: { in: tenants } };
    await admin.consumerReceipt.deleteMany({ where });
    await admin.jobDelivery.deleteMany({ where });
    await admin.outboxEvent.deleteMany({ where });
    await admin.auditEvent.deleteMany({ where });
    await admin.workforceReportExport.deleteMany({ where });
    await admin.employeeAssignment.deleteMany({ where });
    await admin.employmentPeriod.deleteMany({ where });
    await admin.employee.deleteMany({ where });
    await admin.designation.deleteMany({ where });
    await admin.department.deleteMany({ where });
    await admin.branch.deleteMany({ where });
    await admin.legalEntity.deleteMany({ where });
    await admin.membership.deleteMany({ where });
    await admin.tenant.deleteMany({ where: { id: { in: tenants } } });
    await admin.identity.deleteMany({
      where: { id: { in: [ownerId, employeeIdentityId, otherOwnerId] } },
    });
  });

  afterAll(async () =>
    Promise.all([
      admin.$disconnect(),
      runtime.$disconnect(),
      worker.$disconnect(),
    ]),
  );

  it('creates once, generates asynchronously and audits authorized downloads', async () => {
    const requestKey = randomUUID();
    const [first, replay] = await Promise.all([
      createTenantWorkforceReportExport(
        runtime,
        actor(ownerId),
        tenantId,
        requestKey,
        input,
      ),
      createTenantWorkforceReportExport(
        runtime,
        actor(ownerId),
        tenantId,
        requestKey,
        input,
      ),
    ]);
    expect(first.id).toBe(replay.id);
    expect(first.status).toBe('pending');
    expect(
      await admin.workforceReportExport.count({ where: { tenantId } }),
    ).toBe(1);
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'workforce_report_export.created' },
      }),
    ).toBe(1);
    expect(
      await admin.outboxEvent.count({
        where: {
          tenantId,
          type: 'workforce_report_export.requested.v1',
          aggregateId: first.id,
        },
      }),
    ).toBe(1);
    await expect(
      authorizeTenantWorkforceReportExportDownload(
        runtime,
        actor(ownerId),
        tenantId,
        first.id,
      ),
    ).rejects.toThrow('INVALID_STATE');

    const event = await admin.outboxEvent.findFirstOrThrow({
      where: { tenantId, aggregateId: first.id },
    });
    expect(await processEvent(worker, { eventId: event.id, tenantId })).toBe(
      'completed',
    );
    expect(await processEvent(worker, { eventId: event.id, tenantId })).toBe(
      'completed',
    );
    const ready = await readTenantWorkforceReportExport(
      runtime,
      actor(ownerId),
      tenantId,
      first.id,
    );
    expect(ready.status).toBe('ready');
    await admin.department.updateMany({
      where: { tenantId },
      data: { name: 'Changed after immutable snapshot' },
    });
    const download = await authorizeTenantWorkforceReportExportDownload(
      runtime,
      actor(ownerId),
      tenantId,
      first.id,
    );
    expect(download.report).toMatchObject({
      ...parameters,
      headcount: 1,
      joiners: 1,
      leavers: 0,
      departments: [
        {
          departmentCode: 'ENG',
          departmentName: 'Engineering, North',
          headcount: 1,
        },
      ],
    });
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'workforce_report_export.downloaded' },
      }),
    ).toBe(1);
    expect(
      await admin.consumerReceipt.count({ where: { eventId: event.id } }),
    ).toBe(1);
  });

  it('binds idempotency content and denies roles, stale MFA and other tenants', async () => {
    const requestKey = randomUUID();
    const created = await createTenantWorkforceReportExport(
      runtime,
      actor(ownerId),
      tenantId,
      requestKey,
      input,
    );
    await expect(
      createTenantWorkforceReportExport(
        runtime,
        actor(ownerId),
        tenantId,
        requestKey,
        { ...input, reason: 'Changed reuse must conflict' },
      ),
    ).rejects.toThrow('CONFLICT');
    await expect(
      createTenantWorkforceReportExport(
        runtime,
        actor(employeeIdentityId),
        tenantId,
        randomUUID(),
        input,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readTenantWorkforceReportExport(
        runtime,
        actor(ownerId, false),
        tenantId,
        created.id,
      ),
    ).rejects.toThrow('FORBIDDEN');
    await expect(
      readTenantWorkforceReportExport(
        runtime,
        actor(otherOwnerId),
        otherTenantId,
        created.id,
      ),
    ).rejects.toThrow('NOT_FOUND');
    await expect(runtime.workforceReportExport.findMany()).rejects.toThrow();
    await expect(worker.workforceReportExport.findMany()).rejects.toThrow();
    await expect(
      runtime.$queryRaw`SELECT public.workforce_headcount_report_json(
        ${tenantId}::uuid,'2026-09-25'::date,'2026-09-01'::date,'2026-09-30'::date
      )`,
    ).rejects.toThrow();
  });

  it('retries a requested export event whose artifact is unavailable', async () => {
    const event = await admin.outboxEvent.create({
      data: {
        tenantId,
        type: 'workforce_report_export.requested.v1',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
      },
    });
    expect(await processEvent(worker, { eventId: event.id, tenantId })).toBe(
      'retry',
    );
    expect(
      await admin.jobDelivery.findUniqueOrThrow({
        where: { eventId: event.id },
      }),
    ).toMatchObject({ attempts: 1, lastError: 'EXPORT_UNAVAILABLE' });
  });

  it('expires artifacts after 24 hours and refuses later download', async () => {
    const created = await createTenantWorkforceReportExport(
      runtime,
      actor(ownerId),
      tenantId,
      randomUUID(),
      input,
    );
    const event = await admin.outboxEvent.findFirstOrThrow({
      where: { tenantId, aggregateId: created.id },
    });
    expect(await processEvent(worker, { eventId: event.id, tenantId })).toBe(
      'completed',
    );
    await admin.workforceReportExport.update({
      where: { id: created.id },
      data: {
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    expect(
      (
        await readTenantWorkforceReportExport(
          runtime,
          actor(ownerId),
          tenantId,
          created.id,
        )
      ).status,
    ).toBe('expired');
    await expect(
      authorizeTenantWorkforceReportExportDownload(
        runtime,
        actor(ownerId),
        tenantId,
        created.id,
      ),
    ).rejects.toThrow('INVALID_STATE');
    expect(
      await admin.auditEvent.count({
        where: { tenantId, action: 'workforce_report_export.downloaded' },
      }),
    ).toBe(0);
  });
});
