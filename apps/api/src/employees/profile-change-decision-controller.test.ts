import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { ProfileChangeDecisionController } from './profile-change-decision-controller';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const requestId = randomUUID();
const now = Math.floor(Date.now() / 1000);
const list = vi.fn();
const decide = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ProfileChangeDecisionController],
    providers: [
      {
        provide: AuthService,
        useValue: {
          limit: vi.fn().mockResolvedValue(undefined),
          session: vi.fn().mockResolvedValue({
            identityId,
            selectedTenantId: tenantId,
            csrf,
            authTime: now,
            expiresAt: now + 300,
            principal: { mfaVerified: true },
          }),
          origin: () => origin,
        },
      },
      {
        provide: DatabaseService,
        useValue: {
          readProfileChangeRequests: list,
          decideProfileChangeRequest: decide,
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

const base = `/api/v1/tenants/${tenantId}/profile-change-requests`;

it('lists private proposals only through selected-tenant context', async () => {
  list.mockResolvedValueOnce({ requests: [] });
  await request(app.getHttpServer())
    .get(base)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .expect(200, { requests: [] });
  expect(list).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
});

it('accepts only a strict, CSRF-protected idempotent decision', async () => {
  const key = randomUUID();
  const input = {
    expectedVersion: 1,
    decision: 'approved',
    reason: 'Verified requested contact details',
  };
  decide.mockResolvedValueOnce({ id: requestId, status: 'approved' });
  await request(app.getHttpServer())
    .post(`${base}/${requestId}/decision`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .set('Idempotency-Key', key)
    .send(input)
    .expect(201);
  expect(decide).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    requestId,
    key,
    input,
  );
  await request(app.getHttpServer())
    .post(`${base}/${requestId}/decision`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Idempotency-Key', randomUUID())
    .send(input)
    .expect(403);
  await request(app.getHttpServer())
    .post(`${base}/${requestId}/decision`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .set('Idempotency-Key', randomUUID())
    .send({ ...input, personalEmail: 'forged@example.com' })
    .expect(400);
  await request(app.getHttpServer())
    .post(`${base}/${requestId}/decision`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(input)
    .expect(400);
  expect(decide).toHaveBeenCalledTimes(1);
});
