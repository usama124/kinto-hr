import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { DeviceInventoryController } from './device-controller';
import { DomainError } from '@kinto/domain';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const branchId = randomUUID();
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
  readDevices: vi.fn(),
  createDevice: vi.fn(),
  updateDevice: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [DeviceInventoryController],
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

const base = `/api/v1/tenants/${tenantId}/devices`;
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

const input = {
  branchId,
  code: 'K50-01',
  name: 'Synthetic entrance',
  model: 'ZKTeco_K50',
  firmware: null,
  sourceTimezone: 'Asia/Karachi',
  reason: 'initial_setup',
};
const revision = {
  branchId,
  name: 'Renamed entrance',
  model: 'ZKTeco_K50',
  firmware: null,
  sourceTimezone: 'Asia/Karachi',
  expectedVersion: 1,
  status: 'draft',
  reason: 'metadata_correction',
};
const mutate = (verb: 'post' | 'put', path = base) =>
  authenticated(verb, path).set('Origin', origin).set('X-CSRF-Token', csrf);

it('uses selected tenant and fresh server-derived actor for inventory reads and writes', async () => {
  methods.readDevices.mockResolvedValueOnce({ items: [], nextCursor: null });
  await authenticated('get', base + '?limit=10').expect(200, {
    items: [],
    nextCursor: null,
  });
  expect(methods.readDevices).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    { limit: 10 },
  );
  methods.createDevice.mockResolvedValueOnce({ id: branchId, version: 1 });
  await mutate('post').send(input).expect(201, { id: branchId, version: 1 });
  expect(methods.createDevice).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    input,
  );
  methods.updateDevice.mockResolvedValueOnce({ id: branchId, version: 2 });
  await mutate('put', base + '/' + branchId)
    .send(revision)
    .expect(200, { id: branchId, version: 2 });
  expect(methods.updateDevice).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    branchId,
    revision,
  );
});

it('rejects caller authority, device secrets, activation and invalid query fields before database access', async () => {
  for (const extra of [
    { tenantId },
    { actor: { identityId } },
    { password: 'secret' },
    { host: '192.168.1.5' },
    { adapterVersion: 'caller' },
    { status: 'active' },
  ])
    await mutate('post')
      .send({ ...input, ...extra })
      .expect(400);
  await authenticated('get', base + '?limit=51').expect(400);
  await authenticated('get', base + '?afterId=bad').expect(400);
  await authenticated('get', base + '?tenantId=' + tenantId).expect(400);
  await mutate('put', base + '/bad')
    .send(revision)
    .expect(400);
  expect(methods.createDevice).not.toHaveBeenCalled();
  expect(methods.readDevices).not.toHaveBeenCalled();
  expect(methods.updateDevice).not.toHaveBeenCalled();
});

it('enforces session, selected-tenant, origin and CSRF boundaries', async () => {
  await request(app.getHttpServer()).get(base).expect(401);
  await authenticated('post', base).send(input).expect(403);
  await authenticated('post', base)
    .set('Origin', 'https://evil.example')
    .set('X-CSRF-Token', csrf)
    .send(input)
    .expect(403);
  await authenticated('post', base)
    .set('Origin', origin)
    .set('X-CSRF-Token', 'bad')
    .send(input)
    .expect(403);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('get', base).expect(403);
  expect(methods.createDevice).not.toHaveBeenCalled();
  expect(methods.readDevices).not.toHaveBeenCalled();
});

it('passes stale MFA as false and maps database authorization and version errors safely', async () => {
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  methods.createDevice.mockRejectedValueOnce(new DomainError('FORBIDDEN'));
  await mutate('post').send(input).expect(403);
  expect(methods.createDevice).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    input,
  );
  methods.updateDevice.mockRejectedValueOnce(new DomainError('STALE_VERSION'));
  await mutate('put', base + '/' + branchId)
    .send(revision)
    .expect(409);
  methods.updateDevice.mockRejectedValueOnce(new DomainError('NOT_FOUND'));
  await mutate('put', base + '/' + branchId)
    .send(revision)
    .expect(404);
});
