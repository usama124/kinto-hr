import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { OwnerProvisioningService } from '../provisioning/service';
import { PlatformController } from './controller';

const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const origin = 'https://hr.example.test';
const tenantId = randomUUID();
const identityId = randomUUID();
const now = Math.floor(Date.now() / 1000);
const session = {
  identityId,
  csrf,
  authTime: now,
  expiresAt: now + 300,
  principal: {
    issuer: 'https://identity.example/realm',
    subject: 'platform-operator',
    mfaVerified: true,
  },
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
const previewEntitlementChange = vi.fn();
const createEntitlementChange = vi.fn();
const revokeEntitlementChange = vi.fn();
let app: INestApplication;

const authorized = (call: request.Test) =>
  call
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf);
const change = {
  changeType: 'capacity_addon',
  seatDelta: 10,
  startsAt: '2026-09-08T00:00:00.000Z',
  endsAt: '2026-10-08T00:00:00.000Z',
  reason: 'Approved temporary capacity',
};

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [PlatformController],
    providers: [
      {
        provide: AuthService,
        useValue: { limit, session: getSession, origin: () => origin },
      },
      {
        provide: DatabaseService,
        useValue: {
          previewEntitlementChange,
          createEntitlementChange,
          revokeEntitlementChange,
        },
      },
      { provide: OwnerProvisioningService, useValue: { attempt: vi.fn() } },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

it('previews and creates strict entitlement changes with a recent-MFA actor', async () => {
  previewEntitlementChange.mockResolvedValueOnce({ changes: {} });
  await authorized(
    request(app.getHttpServer()).post(
      `/api/v1/platform/tenants/${tenantId}/entitlement-changes/preview`,
    ),
  )
    .send(change)
    .expect(200, { changes: {} });
  expect(previewEntitlementChange).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    change,
  );

  createEntitlementChange.mockResolvedValueOnce({
    id: randomUUID(),
    version: 1,
    entitlementVersion: 2,
  });
  await authorized(
    request(app.getHttpServer()).post(
      `/api/v1/platform/tenants/${tenantId}/entitlement-changes`,
    ),
  )
    .send(change)
    .expect(201);
  expect(createEntitlementChange).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    change,
  );
});

it('revokes only a typed same-path grant or override version', async () => {
  const changeId = randomUUID();
  const input = { expectedVersion: 1, reason: 'Approval withdrawn' };
  revokeEntitlementChange.mockResolvedValueOnce({
    id: changeId,
    version: 2,
    entitlementVersion: 3,
  });
  await authorized(
    request(app.getHttpServer()).post(
      `/api/v1/platform/tenants/${tenantId}/entitlement-changes/grant/${changeId}/revocation`,
    ),
  )
    .send(input)
    .expect(200);
  expect(revokeEntitlementChange).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    'grant',
    changeId,
    input,
  );
});

it('rejects missing mutation proof and mass-assigned or malformed controls', async () => {
  await request(app.getHttpServer())
    .post(`/api/v1/platform/tenants/${tenantId}/entitlement-changes`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .send(change)
    .expect(403);
  await authorized(
    request(app.getHttpServer()).post(
      `/api/v1/platform/tenants/${tenantId}/entitlement-changes`,
    ),
  )
    .send({ ...change, tenantId })
    .expect(400);
  await authorized(
    request(app.getHttpServer()).post(
      `/api/v1/platform/tenants/${tenantId}/entitlement-changes/other/${randomUUID()}/revocation`,
    ),
  )
    .send({ expectedVersion: 1, reason: 'Invalid kind' })
    .expect(400);
  expect(createEntitlementChange).not.toHaveBeenCalled();
  expect(revokeEntitlementChange).not.toHaveBeenCalled();
});

it('does not treat stale provider MFA as recent', async () => {
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  previewEntitlementChange.mockResolvedValueOnce({ changes: {} });
  await authorized(
    request(app.getHttpServer()).post(
      `/api/v1/platform/tenants/${tenantId}/entitlement-changes/preview`,
    ),
  )
    .send(change)
    .expect(200);
  expect(previewEntitlementChange).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    change,
  );
});
