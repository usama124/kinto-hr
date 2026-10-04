import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { AttendanceAllocationController } from './allocation-controller';
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
  readAttendanceAllocation: vi.fn(),
  changeAttendanceAllocation: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [AttendanceAllocationController],
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

const base = `/api/v1/tenants/${tenantId}/attendance-entitlements`;
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

const platform = `/api/v1/platform/tenants/${tenantId}/attendance-entitlements`;
const input = {
  expectedVersion: 0,
  enabled: true,
  deviceLimit: 2,
  connectorLimit: 1,
  reason: 'initial_setup',
};
const mutation = () =>
  authenticated('put', platform)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .set('Idempotency-Key', requestId);

it('uses selected tenant for company reads and separate database operator authority for platform routes', async () => {
  methods.readAttendanceAllocation.mockResolvedValue({
    version: 0,
    enabled: false,
  });
  await authenticated('get', base).expect(200);
  expect(methods.readAttendanceAllocation).toHaveBeenLastCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    false,
  );
  getSession.mockResolvedValueOnce({ ...session, selectedTenantId: null });
  await authenticated('get', platform).expect(200);
  expect(methods.readAttendanceAllocation).toHaveBeenLastCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    true,
  );
  methods.changeAttendanceAllocation.mockResolvedValueOnce({
    id: requestId,
    version: 1,
    replayed: false,
  });
  await mutation().send(input).expect(200);
  expect(methods.changeAttendanceAllocation).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    requestId,
    input,
  );
});

it('rejects caller authority, invalid capacities and missing retry keys before database calls', async () => {
  await authenticated('put', platform)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(input)
    .expect(400);
  for (const extra of [
    { deviceLimit: 0 },
    { connectorLimit: 1001 },
    { actorId: identityId },
    { machineAccessAvailable: true },
    { reason: 'private text' },
  ])
    await mutation()
      .send({ ...input, ...extra })
      .expect(400);
  expect(methods.changeAttendanceAllocation).not.toHaveBeenCalled();
});

it('requires selected company reads and session/origin/CSRF protection for allocation writes', async () => {
  await request(app.getHttpServer()).get(base).expect(401);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('get', base).expect(403);
  await authenticated('put', platform)
    .set('Idempotency-Key', requestId)
    .send(input)
    .expect(403);
  await mutation()
    .set('Origin', 'https://evil.example')
    .send(input)
    .expect(403);
  await mutation().set('X-CSRF-Token', 'wrong').send(input).expect(403);
  expect(methods.readAttendanceAllocation).not.toHaveBeenCalled();
  expect(methods.changeAttendanceAllocation).not.toHaveBeenCalled();
});

it('passes stale MFA as false and exposes only safe denial/version outcomes', async () => {
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  methods.changeAttendanceAllocation.mockRejectedValueOnce(
    new DomainError('FORBIDDEN'),
  );
  await mutation().send(input).expect(403);
  expect(methods.changeAttendanceAllocation).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    requestId,
    input,
  );
  methods.changeAttendanceAllocation.mockRejectedValueOnce(
    new DomainError('STALE_VERSION'),
  );
  await mutation().send(input).expect(409);
  methods.readAttendanceAllocation.mockRejectedValueOnce(
    new DomainError('NOT_FOUND'),
  );
  await authenticated('get', platform).expect(404);
});
