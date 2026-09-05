import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { MembershipsController } from './controller';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const membershipId = randomUUID();
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
const listMemberships = vi.fn();
const updateMembershipRoles = vi.fn();
const revokeMembership = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [MembershipsController],
    providers: [
      {
        provide: AuthService,
        useValue: { limit, session: getSession, origin: () => origin },
      },
      {
        provide: DatabaseService,
        useValue: {
          listMemberships,
          updateMembershipRoles,
          revokeMembership,
        },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const authenticated = (method: 'get' | 'put' | 'post', path: string) => {
  const client = request(app.getHttpServer());
  const pending =
    method === 'get'
      ? client.get(path)
      : method === 'put'
        ? client.put(path)
        : client.post(path);
  return pending.set('Cookie', `__Host-kinto-session=${token}`);
};

it('passes only the server session actor to membership listing', async () => {
  listMemberships.mockResolvedValueOnce([
    {
      id: membershipId,
      identityId,
      status: 'active',
      roles: ['owner'],
      version: 1,
      employeeId: null,
      createdAt: new Date(),
    },
  ]);
  const response = await authenticated(
    'get',
    `/api/v1/tenants/${tenantId}/memberships`,
  ).expect(200);
  expect(response.body.memberships).toHaveLength(1);
  expect(listMemberships).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
});

it('rejects a tenant path that is not the selected session workspace', async () => {
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('get', `/api/v1/tenants/${tenantId}/memberships`).expect(
    403,
  );
  expect(listMemberships).not.toHaveBeenCalled();
});

it('requires exact origin and CSRF before changing roles', async () => {
  const path = `/api/v1/tenants/${tenantId}/memberships/${membershipId}/roles`;
  const body = {
    expectedVersion: 1,
    roles: ['hr_admin'],
    reason: 'Approved HR access',
  };
  await authenticated('put', path).send(body).expect(403);
  expect(updateMembershipRoles).not.toHaveBeenCalled();
  updateMembershipRoles.mockResolvedValueOnce({
    id: membershipId,
    status: 'active',
    roles: ['hr_admin'],
    version: 2,
  });
  await authenticated('put', path)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(body)
    .expect(200);
  expect(updateMembershipRoles).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    membershipId,
    body,
  );
});

it('rejects mass assignment and passes stale MFA as unverified', async () => {
  getSession.mockResolvedValueOnce({
    ...session,
    authTime: now - 301,
  });
  revokeMembership.mockResolvedValueOnce({
    id: membershipId,
    status: 'revoked',
    roles: ['hr_admin'],
    version: 2,
  });
  await authenticated(
    'post',
    `/api/v1/tenants/${tenantId}/memberships/${membershipId}/revocation`,
  )
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send({ expectedVersion: 1, reason: 'Access removed' })
    .expect(200);
  expect(revokeMembership).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    membershipId,
    { expectedVersion: 1, reason: 'Access removed' },
  );
  await authenticated(
    'post',
    `/api/v1/tenants/${tenantId}/memberships/${membershipId}/revocation`,
  )
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send({
      expectedVersion: 1,
      reason: 'Access removed',
      status: 'revoked',
    })
    .expect(400);
});
