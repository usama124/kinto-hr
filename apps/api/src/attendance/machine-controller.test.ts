import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  type INestApplication,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DomainError } from '@kinto/domain';
import { AuthService } from '../auth/service';
import { configureHttp } from '../http';
import { MachineService } from './machine-service';
import { MachineController } from './machine-controller';
import { LocalConnectorOwnerController } from './local-owner-controller';

const tenantId = randomUUID(),
  identityId = randomUUID(),
  id = randomUUID();
const token = 'ke1_' + 'a'.repeat(43),
  credential = 'kc1_' + 'b'.repeat(43),
  csrf = 'c'.repeat(43);
const origin = 'https://kinto.example';
const session = {
  identityId,
  selectedTenantId: tenantId,
  csrf,
  authTime: Math.floor(Date.now() / 1000),
  principal: { mfaVerified: true },
};
const methods = {
  enabled: vi.fn(),
  limit: vi.fn(),
  redeem: vi.fn(),
  authorize: vi.fn(),
  issue: vi.fn(),
  enrollments: vi.fn(),
  credentials: vi.fn(),
  revokeEnrollment: vi.fn(),
  revokeCredential: vi.fn(),
};
const auth = { limit: vi.fn(), session: vi.fn(), origin: () => origin };
const connector = {
  id,
  tenantId,
  deviceId: id,
  enrollmentId: id,
  version: 1,
  status: 'active',
  createdAt: '2026-10-04T00:00:00Z',
  expiresAt: '2026-11-03T00:00:00Z',
  revokedAt: null,
  scope: 'heartbeat_only',
  attendanceIngestionAvailable: false,
};
let app: INestApplication;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [MachineController, LocalConnectorOwnerController],
    providers: [
      { provide: MachineService, useValue: methods },
      { provide: AuthService, useValue: auth },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});
afterAll(async () => app?.close());
beforeEach(() => {
  vi.resetAllMocks();
  auth.session.mockResolvedValue(session);
  methods.authorize.mockResolvedValue(connector);
});
const machine = '/api/v1/local-machine/connectors',
  owner = `/api/v1/tenants/${tenantId}/local-connectors`;
const heartbeat = () =>
  request(app.getHttpServer())
    .post(machine + '/heartbeat')
    .set('Authorization', 'Bearer ' + credential);
const authenticated = (path: string) =>
  request(app.getHttpServer())
    .post(owner + path)
    .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf);
it('admits machine redemption and scoped heartbeat without browser authentication', async () => {
  methods.redeem.mockResolvedValue({ connector, credential });
  const redeemed = await request(app.getHttpServer())
    .post(machine + '/redemption')
    .send({ token })
    .expect(201);
  expect(redeemed.headers['cache-control']).toBe('no-store');
  expect(redeemed.body.credential).toBe(credential);
  expect(methods.redeem).toHaveBeenCalledWith(token);
  const result = await heartbeat().send({}).expect(200);
  expect(result.body).toEqual({ connector });
  expect(methods.authorize).toHaveBeenCalledWith(credential);
  expect(auth.session).not.toHaveBeenCalled();
});
it.each([
  'Cookie',
  'Origin',
  'Forwarded',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
])('rejects %s assertions on machine routes', async (header) => {
  await heartbeat().set(header, 'untrusted').send({}).expect(403);
  await request(app.getHttpServer())
    .post(machine + '/redemption')
    .set(header, 'untrusted')
    .send({ token })
    .expect(403);
  expect(methods.authorize).not.toHaveBeenCalled();
  expect(methods.redeem).not.toHaveBeenCalled();
});
it('rejects malformed bearers, scope injection and redemption ambiguity', async () => {
  for (const header of [
    '',
    credential,
    'Bearer ' + token,
    'Bearer ' + credential + ' extra',
    'bearer ' + credential,
  ])
    await request(app.getHttpServer())
      .post(machine + '/heartbeat')
      .set('Authorization', header)
      .send({})
      .expect(401);
  await heartbeat().send({ tenantId }).expect(400);
  await request(app.getHttpServer())
    .post(machine + '/redemption')
    .send({ token, tenantId })
    .expect(400);
  await request(app.getHttpServer())
    .post(machine + '/redemption')
    .set('Authorization', 'Bearer ' + credential)
    .send({ token })
    .expect(400);
  expect(methods.authorize).not.toHaveBeenCalled();
  expect(methods.redeem).not.toHaveBeenCalled();
});
it('fails closed when disabled, rate limited or credential authority is denied without disclosing secrets', async () => {
  methods.enabled.mockImplementation(() => {
    throw new NotFoundException();
  });
  await heartbeat().send({}).expect(404);
  expect(methods.authorize).not.toHaveBeenCalled();
  methods.enabled.mockReset();
  methods.limit.mockRejectedValue(new HttpException('sensitive', 429));
  await heartbeat().send({}).expect(429);
  methods.limit.mockReset();
  methods.authorize.mockRejectedValue(new DomainError('FORBIDDEN'));
  const result = await heartbeat().send({}).expect(403);
  expect(JSON.stringify(result.body)).not.toContain(credential);
  methods.redeem.mockRejectedValue(new Error(token));
  const failed = await request(app.getHttpServer())
    .post(machine + '/redemption')
    .send({ token })
    .expect(500);
  expect(JSON.stringify(failed.body)).not.toContain(token);
});
it('owner commands derive fresh identity and MFA and enforce company, origin, CSRF and exact request key', async () => {
  const key = randomUUID(),
    input = {
      deviceId: id,
      expectedDeviceVersion: 1,
      expectedAllocationVersion: 1,
    };
  await authenticated('/enrollment-tokens')
    .set('Idempotency-Key', key)
    .send(input)
    .expect(201);
  expect(methods.issue).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    key,
    input,
  );
  await authenticated('/credentials/' + id + '/revocation')
    .send({ expectedVersion: 1 })
    .expect(201);
  expect(methods.revokeCredential).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    id,
  );
  await authenticated('/enrollment-tokens/' + id + '/revocation')
    .send({ expectedVersion: 1 })
    .expect(201);
  expect(methods.revokeEnrollment).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    id,
  );
  await authenticated('/credentials/' + id + '/revocation')
    .set('Origin', 'https://evil.example')
    .send({ expectedVersion: 1 })
    .expect(403);
  await authenticated('/credentials/' + id + '/revocation')
    .set('X-CSRF-Token', 'x')
    .send({ expectedVersion: 1 })
    .expect(403);
  auth.session.mockResolvedValue({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('/credentials/' + id + '/revocation')
    .send({ expectedVersion: 1 })
    .expect(403);
  auth.session.mockResolvedValue({ ...session, authTime: 1 });
  await authenticated('/credentials/' + id + '/revocation')
    .send({ expectedVersion: 1 })
    .expect(201);
  expect(methods.revokeCredential).toHaveBeenLastCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    id,
  );
});
it('requires browser login for metadata and denies machine credentials as owner authentication', async () => {
  await request(app.getHttpServer())
    .get(owner + '/credentials')
    .set('Authorization', 'Bearer ' + credential)
    .expect(401);
  await request(app.getHttpServer())
    .get(owner + '/enrollment-tokens')
    .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
    .expect(200);
  expect(methods.enrollments).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    { limit: 25 },
  );
  await request(app.getHttpServer())
    .get(owner + '/credentials?limit=1')
    .set('Cookie', '__Host-kinto-session=' + 's'.repeat(43))
    .expect(200);
  expect(methods.credentials).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    { limit: 1 },
  );
});

it('rejects non-loopback sockets instead of trusting spoofed forwarding addresses', async () => {
  const controller = new MachineController(
    methods as unknown as MachineService,
  );
  await expect(
    controller.heartbeat(
      {
        headers: { authorization: 'Bearer ' + credential },
        socket: { remoteAddress: '192.0.2.1' },
        originalUrl: machine + '/heartbeat',
      },
      {},
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(methods.limit).not.toHaveBeenCalled();
  expect(methods.authorize).not.toHaveBeenCalled();
});
it('validates owner metadata, version and idempotency contracts before commands', async () => {
  await authenticated('/enrollment-tokens')
    .send({
      deviceId: id,
      expectedDeviceVersion: 1,
      expectedAllocationVersion: 1,
    })
    .expect(400);
  await authenticated('/credentials/' + id + '/revocation')
    .send({ expectedVersion: 2 })
    .expect(400);
  await request(app.getHttpServer())
    .get(owner + '/credentials?limit=51')
    .expect(400);
  expect(methods.issue).not.toHaveBeenCalled();
  expect(methods.revokeCredential).not.toHaveBeenCalled();
});
