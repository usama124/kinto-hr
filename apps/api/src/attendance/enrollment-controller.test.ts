import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { ConnectorEnrollmentController } from './enrollment-controller';
import { DomainError } from '@kinto/domain';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const requestId = randomUUID();
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
const methods = {
  issueConnectorEnrollment: vi.fn(),
  revokeConnectorEnrollment: vi.fn(),
  listConnectorEnrollments: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ConnectorEnrollmentController],
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

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(session);
});
afterAll(async () => app?.close());

const base = `/api/v1/tenants/${tenantId}/connectors/enrollment-tokens`;
const authenticated = (verb: 'get' | 'post' | 'put', path: string) => {
  const client = request(app.getHttpServer());
  const call =
    verb === 'get'
      ? client.get(path)
      : verb === 'post'
        ? client.post(path)
        : client.put(path);
  return call.set('Cookie', `__Host-kinto-session=${token}`);
};

const deviceId = randomUUID();
const input = {
  deviceId,
  expectedDeviceVersion: 1,
  expectedAllocationVersion: 1,
};
const mutation = () =>
  authenticated('post', base)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .set('Idempotency-Key', requestId);
it('issues through selected company with derived actor and safe request key', async () => {
  methods.issueConnectorEnrollment.mockResolvedValue({
    token: 'synthetic-one-time-token',
  });
  await mutation().send(input).expect(201);
  expect(methods.issueConnectorEnrollment).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    requestId,
    input,
  );
  await authenticated('get', base + '?limit=1').expect(200);
  expect(methods.listConnectorEnrollments).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    { limit: 1 },
  );
  await authenticated('post', base + '/' + deviceId + '/revocation')
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send({ expectedVersion: 1 })
    .expect(201);
  expect(methods.revokeConnectorEnrollment).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    deviceId,
    { expectedVersion: 1 },
  );
});
it('rejects missing login, wrong company, origin and CSRF before issuing tokens', async () => {
  await request(app.getHttpServer())
    .post(base)
    .set('Idempotency-Key', requestId)
    .send(input)
    .expect(401);
  await authenticated('post', base)
    .set('Idempotency-Key', requestId)
    .send(input)
    .expect(403);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await mutation().send(input).expect(403);
  expect(methods.issueConnectorEnrollment).not.toHaveBeenCalled();
});
it('rejects invalid scope, forged fields, request keys and list limits', async () => {
  for (const invalid of [
    { ...input, tenantId },
    { ...input, expectedAllocationVersion: 0 },
    { ...input, expectedDeviceVersion: 0 },
  ])
    await mutation().send(invalid).expect(400);
  await authenticated('post', base)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(input)
    .expect(400);
  await authenticated('get', base + '?limit=51').expect(400);
  await authenticated('post', base + '/' + deviceId + '/revocation')
    .send({ expectedVersion: 2 })
    .expect(400);
  expect(methods.issueConnectorEnrollment).not.toHaveBeenCalled();
});
it('passes stale or absent MFA as unverified and returns only safe domain errors', async () => {
  methods.issueConnectorEnrollment.mockRejectedValue(
    new DomainError('FORBIDDEN'),
  );
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  const response = await mutation().send(input).expect(403);
  expect(methods.issueConnectorEnrollment).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    requestId,
    input,
  );
  expect(response.body.message).toBe('Request could not be completed');
});
