import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { ReportsController } from './controller';

const identityId = randomUUID();
const tenantId = randomUUID();
const token = 'a'.repeat(43);
const now = Math.floor(Date.now() / 1000);
const session = {
  identityId,
  selectedTenantId: tenantId,
  csrf: 'b'.repeat(43),
  authTime: now,
  expiresAt: now + 300,
  principal: {
    issuer: 'https://identity.example/realm',
    subject: 'owner',
    mfaVerified: true,
  },
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
const readWorkforceHeadcountReport = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [
      { provide: AuthService, useValue: { limit, session: getSession } },
      {
        provide: DatabaseService,
        useValue: { readWorkforceHeadcountReport },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const path = `/api/v1/tenants/${tenantId}/reports/headcount`;
const authenticated = (query = '') =>
  request(app.getHttpServer())
    .get(`${path}${query}`)
    .set('Cookie', `__Host-kinto-session=${token}`);
const query = '?asOf=2026-09-25&periodStart=2026-09-01&periodEnd=2026-09-30';

it('passes selected tenant, recent MFA and bounded report dates', async () => {
  const report = {
    asOf: '2026-09-25',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    headcount: 2,
    joiners: 1,
    leavers: 1,
    departments: [],
    unassignedHeadcount: 0,
  };
  readWorkforceHeadcountReport.mockResolvedValueOnce(report);
  await authenticated(query).expect(200, report);
  expect(readWorkforceHeadcountReport).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    {
      asOf: '2026-09-25',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    },
  );
});

it('rejects missing, reversed, excessive and unexpected query values', async () => {
  await authenticated().expect(400);
  await authenticated(
    '?asOf=2026-09-25&periodStart=2026-10-01&periodEnd=2026-09-30',
  ).expect(400);
  await authenticated(
    '?asOf=2026-09-25&periodStart=2026-01-01&periodEnd=2028-01-02',
  ).expect(400);
  await authenticated(`${query}&employeeId=${randomUUID()}`).expect(400);
  expect(readWorkforceHeadcountReport).not.toHaveBeenCalled();
});

it('requires authentication and passes stale MFA as unverified', async () => {
  await request(app.getHttpServer()).get(`${path}${query}`).expect(401);
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  readWorkforceHeadcountReport.mockResolvedValueOnce({});
  await authenticated(query).expect(200);
  expect(readWorkforceHeadcountReport).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    expect.any(Object),
  );
});

it('rejects a path outside the selected workspace', async () => {
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated(query).expect(403);
  expect(readWorkforceHeadcountReport).not.toHaveBeenCalled();
});
