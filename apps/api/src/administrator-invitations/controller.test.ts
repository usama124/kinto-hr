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
import { AdministratorInvitationsController } from './controller';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const requestKey = randomUUID();
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
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
const provisionAdministrator = vi.fn();
const attemptAdministrator = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [AdministratorInvitationsController],
    providers: [
      {
        provide: AuthService,
        useValue: { limit, session: getSession, origin: () => origin },
      },
      { provide: DatabaseService, useValue: { provisionAdministrator } },
      {
        provide: OwnerProvisioningService,
        useValue: { attemptAdministrator },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const validBody = {
  email: ' Admin@Example.COM ',
  roles: ['payroll_approver', 'hr_admin'],
  reason: 'Approved operational responsibilities',
};
const call = () =>
  request(app.getHttpServer())
    .post(`/api/v1/tenants/${tenantId}/administrator-invitations`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .set('Idempotency-Key', requestKey);

it('derives the actor from the session and returns provider delivery state', async () => {
  provisionAdministrator.mockResolvedValueOnce({
    accountRequestId: randomUUID(),
    status: 'pending_identity_provider',
    replayed: false,
  });
  attemptAdministrator.mockResolvedValueOnce({ status: 'pending_activation' });
  const response = await call().send(validBody).expect(202);
  expect(response.body.status).toBe('pending_activation');
  expect(provisionAdministrator).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    requestKey,
    {
      email: 'admin@example.com',
      roles: ['hr_admin', 'payroll_approver'],
      reason: validBody.reason,
    },
  );
  expect(attemptAdministrator).toHaveBeenCalledWith(
    response.body.accountRequestId,
    'admin@example.com',
  );
});

it('requires exact Origin and CSRF before any request is recorded', async () => {
  await request(app.getHttpServer())
    .post(`/api/v1/tenants/${tenantId}/administrator-invitations`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Idempotency-Key', requestKey)
    .send(validBody)
    .expect(403);
  expect(provisionAdministrator).not.toHaveBeenCalled();
});

it('rejects employee/platform roles and passes stale MFA as unverified', async () => {
  await call()
    .send({ ...validBody, roles: ['employee'], tenantId })
    .expect(400);
  expect(provisionAdministrator).not.toHaveBeenCalled();
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  provisionAdministrator.mockResolvedValueOnce({
    accountRequestId: randomUUID(),
    status: 'pending_identity_provider',
    replayed: false,
  });
  attemptAdministrator.mockResolvedValueOnce(undefined);
  await call().send(validBody).expect(202);
  expect(provisionAdministrator.mock.calls[0][0]).toEqual({
    identityId,
    mfaVerified: false,
  });
});
