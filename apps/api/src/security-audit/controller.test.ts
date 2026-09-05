import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { SecurityAuditController } from './controller';

const identityId = randomUUID();
const tenantId = randomUUID();
const token = 'a'.repeat(43);
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
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
const listSecurityAudit = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [SecurityAuditController],
    providers: [
      { provide: AuthService, useValue: { limit, session: getSession } },
      { provide: DatabaseService, useValue: { listSecurityAudit } },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});

beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const path = `/api/v1/tenants/${tenantId}/security-audit`;
const authenticated = (suffix = '') =>
  request(app.getHttpServer())
    .get(`${path}${suffix}`)
    .set('Cookie', `__Host-kinto-session=${token}`);

it('passes a recent-MFA server actor and bounded filters', async () => {
  listSecurityAudit.mockResolvedValueOnce({ items: [], nextCursor: null });
  await authenticated(
    '?limit=25&action=membership.roles_changed&from=2026-09-01T00%3A00%3A00Z',
  ).expect(200, { items: [], nextCursor: null });
  expect(listSecurityAudit).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    {
      limit: 25,
      action: 'membership.roles_changed',
      from: '2026-09-01T00:00:00Z',
    },
  );
});

it('rejects invalid filters and a path outside the selected workspace', async () => {
  await authenticated('?limit=101').expect(400);
  await authenticated('?action=Membership%20changed').expect(400);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated().expect(403);
  expect(listSecurityAudit).not.toHaveBeenCalled();
});

it('requires authentication and passes stale MFA as unverified', async () => {
  await request(app.getHttpServer()).get(path).expect(401);
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  listSecurityAudit.mockResolvedValueOnce({ items: [], nextCursor: null });
  await authenticated().expect(200);
  expect(listSecurityAudit).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    {},
  );
});
