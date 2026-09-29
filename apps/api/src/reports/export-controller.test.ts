import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { ReportExportsController } from './export-controller';

const origin = 'https://kinto.example';
const identityId = randomUUID();
const tenantId = randomUUID();
const exportId = randomUUID();
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const now = Math.floor(Date.now() / 1000);
const session = {
  identityId,
  selectedTenantId: tenantId,
  csrf,
  authTime: now,
  expiresAt: now + 300,
  principal: {
    issuer: 'https://identity.example/realm',
    subject: 'owner',
    mfaVerified: true,
  },
};
const parameters = {
  asOf: '2026-09-25',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
};
const exportView = {
  id: exportId,
  kind: 'workforce_headcount_csv' as const,
  status: 'pending' as const,
  parameters,
  createdAt: '2026-09-25T10:00:00.000Z',
  expiresAt: '2026-09-26T10:00:00.000Z',
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
const methods = {
  createWorkforceReportExport: vi.fn(),
  readWorkforceReportExport: vi.fn(),
  authorizeWorkforceReportExportDownload: vi.fn(),
};
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ReportExportsController],
    providers: [
      {
        provide: AuthService,
        useValue: { limit, session: getSession, origin: () => origin },
      },
      { provide: DatabaseService, useValue: methods },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const base = `/api/v1/tenants/${tenantId}/exports`;
const authenticated = (path: string) =>
  request(app.getHttpServer())
    .get(path)
    .set('Cookie', `__Host-kinto-session=${token}`);
const mutation = () =>
  request(app.getHttpServer())
    .post(base)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf);

it('creates a strict idempotent asynchronous export request', async () => {
  const key = randomUUID();
  const body = {
    kind: 'workforce_headcount_csv',
    parameters,
    reason: 'Monthly workforce review',
  };
  methods.createWorkforceReportExport.mockResolvedValueOnce(exportView);
  await mutation()
    .set('Idempotency-Key', key)
    .send(body)
    .expect(202, exportView);
  expect(methods.createWorkforceReportExport).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    key,
    body,
  );
  await mutation().send(body).expect(400);
  await mutation()
    .set('Idempotency-Key', randomUUID())
    .send({ ...body, employeeFields: ['cnic'] })
    .expect(400);
  await request(app.getHttpServer())
    .post(base)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);
});

it('polls only an export in the selected tenant context', async () => {
  methods.readWorkforceReportExport.mockResolvedValueOnce(exportView);
  await authenticated(`${base}/${exportId}`).expect(200, exportView);
  expect(methods.readWorkforceReportExport).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    exportId,
  );
  await authenticated(`${base}/invalid`).expect(400);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated(`${base}/${exportId}`).expect(403);
});

it('downloads ready CSV with no-store attachment headers', async () => {
  methods.authorizeWorkforceReportExportDownload.mockResolvedValueOnce({
    export: { ...exportView, status: 'ready' },
    report: {
      ...parameters,
      headcount: 1,
      joiners: 1,
      leavers: 0,
      departments: [
        {
          departmentId: randomUUID(),
          departmentCode: '=ENG',
          departmentName: 'Engineering, North',
          headcount: 1,
        },
      ],
      unassignedHeadcount: 0,
    },
  });
  const response = await authenticated(`${base}/${exportId}/content`).expect(
    200,
  );
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-type']).toContain('text/csv');
  expect(response.headers['content-disposition']).toBe(
    `attachment; filename="workforce-headcount-2026-09-25-${exportId}.csv"`,
  );
  expect(response.text).toContain("'=ENG");
  expect(response.text).toContain('"Engineering, North"');
  expect(methods.authorizeWorkforceReportExportDownload).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    exportId,
  );
});

it('requires authentication and passes stale MFA as unverified', async () => {
  await request(app.getHttpServer()).get(`${base}/${exportId}`).expect(401);
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  methods.readWorkforceReportExport.mockResolvedValueOnce(exportView);
  await authenticated(`${base}/${exportId}`).expect(200);
  expect(methods.readWorkforceReportExport).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    exportId,
  );
});
