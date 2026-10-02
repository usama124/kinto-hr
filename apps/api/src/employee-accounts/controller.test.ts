import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { OwnerProvisioningService } from '../provisioning/service';
import { configureHttp } from '../http';
import { EmployeeAccountsController } from './controller';
const token = 'a'.repeat(43),
  csrf = 'b'.repeat(43),
  origin = 'https://hr.example.test';
const tenantId = randomUUID(),
  employeeId = randomUUID(),
  identityId = randomUUID(),
  accountRequestId = randomUUID();
const now = Math.floor(Date.now() / 1000);
const session = {
  identityId,
  selectedTenantId: tenantId,
  csrf,
  authTime: now,
  expiresAt: now + 300,
  principal: {
    issuer: 'https://identity.example/realm',
    subject: 'hr-admin',
    mfaVerified: true,
  },
};
const getSession = vi.fn(),
  provisionEmployeeAccount = vi.fn(),
  attemptEmployee = vi.fn();
let app: INestApplication;
const path = `/api/v1/tenants/${tenantId}/employees/${employeeId}/account-invitations`;
const authorized = (url = path) =>
  request(app.getHttpServer())
    .post(url)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf);
beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [EmployeeAccountsController],
    providers: [
      {
        provide: AuthService,
        useValue: {
          limit: vi.fn().mockResolvedValue(undefined),
          session: getSession,
          origin: () => origin,
        },
      },
      { provide: DatabaseService, useValue: { provisionEmployeeAccount } },
      { provide: OwnerProvisioningService, useValue: { attemptEmployee } },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});
beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(session);
  provisionEmployeeAccount.mockReset();
  attemptEmployee.mockReset();
});
afterAll(async () => app?.close());
it('binds employee setup to the selected session, normalized email and exact request key', async () => {
  const key = randomUUID();
  const receipt = {
    accountRequestId,
    status: 'pending_identity_provider',
    replayed: false,
  };
  provisionEmployeeAccount.mockResolvedValue(receipt);
  attemptEmployee.mockResolvedValue(null);
  const response = await authorized()
    .set('Idempotency-Key', key)
    .send({ email: ' Staff@Example.COM ' })
    .expect(202);
  expect(response.body).toEqual(receipt);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(provisionEmployeeAccount).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    key,
    { email: 'staff@example.com' },
  );
  expect(attemptEmployee).toHaveBeenCalledWith(
    accountRequestId,
    'staff@example.com',
  );
});
it('returns typed delivery progress without granting roles through the request', async () => {
  provisionEmployeeAccount.mockResolvedValue({
    accountRequestId,
    status: 'pending_identity_provider',
    replayed: true,
  });
  attemptEmployee.mockResolvedValue({ status: 'pending_activation' });
  await authorized()
    .set('Idempotency-Key', randomUUID())
    .send({ email: 'staff@example.com' })
    .expect(202, {
      accountRequestId,
      status: 'pending_activation',
      replayed: true,
    });
});
it('rejects anonymous, missing-CSRF, cross-company, invalid-key and role-assigned requests', async () => {
  await request(app.getHttpServer())
    .post(path)
    .send({ email: 'staff@example.com' })
    .expect(401);
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .send({ email: 'staff@example.com' })
    .expect(403);
  await authorized(
    `/api/v1/tenants/${randomUUID()}/employees/${employeeId}/account-invitations`,
  )
    .set('Idempotency-Key', randomUUID())
    .send({ email: 'staff@example.com' })
    .expect(403);
  for (const key of ['', 'invalid'])
    await authorized()
      .set('Idempotency-Key', key)
      .send({ email: 'staff@example.com' })
      .expect(400);
  for (const extra of [{ roles: ['owner'] }, { identityId }, { tenantId }])
    await authorized()
      .set('Idempotency-Key', randomUUID())
      .send({ email: 'staff@example.com', ...extra })
      .expect(400);
  expect(provisionEmployeeAccount).not.toHaveBeenCalled();
  expect(attemptEmployee).not.toHaveBeenCalled();
});
it('passes stale MFA as unverified and fails closed on malformed provider results', async () => {
  getSession.mockResolvedValue({ ...session, authTime: now - 301 });
  provisionEmployeeAccount.mockResolvedValue({
    accountRequestId,
    status: 'pending_identity_provider',
    replayed: true,
  });
  attemptEmployee.mockResolvedValue({ status: 'unsupported' });
  await authorized()
    .set('Idempotency-Key', randomUUID())
    .send({ email: 'staff@example.com' })
    .expect(500);
  expect(provisionEmployeeAccount.mock.calls[0]?.[0]).toEqual({
    identityId,
    mfaVerified: false,
  });
});

it.each(['active', 'failed', 'revoked'])(
  'preserves terminal %s request state without attempting provider delivery',
  async (status) => {
    const receipt = { accountRequestId, status, replayed: true };
    provisionEmployeeAccount.mockResolvedValue(receipt);
    await authorized()
      .set('Idempotency-Key', randomUUID())
      .send({ email: 'staff@example.com' })
      .expect(202, receipt);
    expect(attemptEmployee).not.toHaveBeenCalled();
  },
);
