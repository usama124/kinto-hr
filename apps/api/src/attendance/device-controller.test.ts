import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { DeviceMappingController } from './mapping-controller';
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
  readDeviceMappings: vi.fn(),
  resolveDeviceMapping: vi.fn(),
  createDeviceMapping: vi.fn(),
  endDeviceMapping: vi.fn(),
  createDevice: vi.fn(),
  updateDevice: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [DeviceInventoryController, DeviceMappingController],
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

const mappingBase = base + '/' + branchId + '/employee-mappings';
const mappingInput = {
  employeeId: identityId,
  sourceUserId: '0007',
  effectiveFrom: '2026-10-01T00:00:00Z',
  effectiveUntil: null,
  reason: 'initial_mapping',
};
it('routes mapping reads, event-time resolution and keyed writes with selected company and server authority', async () => {
  methods.readDeviceMappings.mockResolvedValueOnce({ items: [] });
  await authenticated('get', mappingBase + '?limit=10').expect(200);
  expect(methods.readDeviceMappings).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    branchId,
    { limit: 10 },
  );
  methods.resolveDeviceMapping.mockResolvedValueOnce({ status: 'unmapped' });
  await authenticated(
    'get',
    mappingBase + '/resolve?sourceUserId=0007&at=2026-10-01T00%3A00%3A00Z',
  ).expect(200);
  expect(methods.resolveDeviceMapping).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    branchId,
    { sourceUserId: '0007', at: '2026-10-01T00:00:00.000Z' },
  );
  const key = randomUUID();
  methods.createDeviceMapping.mockResolvedValueOnce({
    id: identityId,
    version: 1,
    replayed: false,
  });
  await mutate('post', mappingBase)
    .set('Idempotency-Key', key)
    .send(mappingInput)
    .expect(201);
  expect(methods.createDeviceMapping).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    branchId,
    key,
    { ...mappingInput, effectiveFrom: '2026-10-01T00:00:00.000Z' },
  );
  methods.endDeviceMapping.mockResolvedValueOnce({
    id: identityId,
    version: 2,
    replayed: false,
  });
  const end = {
    expectedVersion: 1,
    effectiveUntil: '2026-11-01T00:00:00Z',
    reason: 'end_mapping',
  };
  await mutate('post', mappingBase + '/' + identityId + '/end')
    .set('Idempotency-Key', key)
    .send(end)
    .expect(201);
  expect(methods.endDeviceMapping).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    branchId,
    identityId,
    key,
    { ...end, effectiveUntil: '2026-11-01T00:00:00.000Z' },
  );
});
it('rejects malformed mapping IDs, unkeyed requests, authority fields and invalid effective intervals', async () => {
  await mutate('post', mappingBase).send(mappingInput).expect(400);
  await mutate('post', mappingBase)
    .set('Idempotency-Key', 'bad')
    .send(mappingInput)
    .expect(400);
  for (const change of [
    { tenantId },
    { sourceUserId: 7 },
    { effectiveUntil: mappingInput.effectiveFrom },
    { employeeId: 'bad' },
    { credential: 'secret' },
  ])
    await mutate('post', mappingBase)
      .set('Idempotency-Key', randomUUID())
      .send({ ...mappingInput, ...change })
      .expect(400);
  await authenticated('get', mappingBase + '?limit=51').expect(400);
  await authenticated(
    'get',
    mappingBase + '/resolve?sourceUserId=0007&at=bad',
  ).expect(400);
  await authenticated('get', base + '/bad/employee-mappings').expect(400);
  await mutate('post', mappingBase + '/bad/end')
    .set('Idempotency-Key', randomUUID())
    .send({
      expectedVersion: 1,
      effectiveUntil: '2026-11-01T00:00:00Z',
      reason: 'end_mapping',
    })
    .expect(400);
  expect(methods.createDeviceMapping).not.toHaveBeenCalled();
  expect(methods.endDeviceMapping).not.toHaveBeenCalled();
});
it('enforces mapping session, company, CSRF and recent MFA on reads and writes', async () => {
  await request(app.getHttpServer()).get(mappingBase).expect(401);
  await authenticated('post', mappingBase)
    .set('Idempotency-Key', randomUUID())
    .send(mappingInput)
    .expect(403);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('get', mappingBase).expect(403);
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  methods.createDeviceMapping.mockRejectedValueOnce(
    new DomainError('FORBIDDEN'),
  );
  await mutate('post', mappingBase)
    .set('Idempotency-Key', randomUUID())
    .send(mappingInput)
    .expect(403);
  expect(methods.createDeviceMapping).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    branchId,
    expect.any(String),
    expect.any(Object),
  );
});
it('preserves mapping conflict, stale and forbidden database outcomes with safe HTTP responses', async () => {
  for (const [code, status] of [
    ['CONFLICT', 409],
    ['STALE_VERSION', 409],
    ['FORBIDDEN', 403],
  ] as const) {
    methods.createDeviceMapping.mockRejectedValueOnce(new DomainError(code));
    await mutate('post', mappingBase)
      .set('Idempotency-Key', randomUUID())
      .send(mappingInput)
      .expect(status);
  }
});
