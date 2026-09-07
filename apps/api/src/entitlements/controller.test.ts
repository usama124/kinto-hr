import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { EntitlementsController } from './controller';

const token = 'a'.repeat(43);
const tenantId = randomUUID();
const identityId = randomUUID();
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
const readEntitlements = vi.fn();
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [EntitlementsController],
    providers: [
      {
        provide: AuthService,
        useValue: { limit, session: getSession },
      },
      { provide: DatabaseService, useValue: { readEntitlements } },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

it('reads only the selected tenant with a server-derived recent-MFA actor', async () => {
  const result = {
    plan: { code: 'free', version: 1 },
    billingMode: 'free',
    employeeLimit: 5,
    activeEmployees: 0,
    availableEmployeeSeats: 5,
    capabilities: { companySetup: true },
    entitlementVersion: 1,
    effectiveFrom: '2026-09-08T00:00:00.000Z',
  };
  readEntitlements.mockResolvedValueOnce(result);
  await request(app.getHttpServer())
    .get(`/api/v1/tenants/${tenantId}/entitlements`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .expect(200, result);
  expect(readEntitlements).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
});

it('rejects a different path tenant and does not trust stale MFA', async () => {
  await request(app.getHttpServer())
    .get(`/api/v1/tenants/${randomUUID()}/entitlements`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .expect(403);
  expect(readEntitlements).not.toHaveBeenCalled();

  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  readEntitlements.mockResolvedValueOnce({});
  await request(app.getHttpServer())
    .get(`/api/v1/tenants/${tenantId}/entitlements`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .expect(200);
  expect(readEntitlements).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
  );
});
