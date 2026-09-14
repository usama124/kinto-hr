import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { EmployeeImportsController } from './controller';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const batchId = randomUUID();
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
    subject: 'hr',
    mfaVerified: true,
  },
};
const methods = {
  createEmployeeImportPreview: vi.fn(),
  readEmployeeImportPreview: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [EmployeeImportsController],
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
beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const path = `/api/v1/tenants/${tenantId}/employee-imports`;
const body = {
  fileName: 'employees.csv',
  content:
    'employee_number,display_name,legal_name,joining_date,branch_code,department_code,designation_code,manager_employee_number,top_level_reason\nEMP-001,Sana Khan,,2026-09-14,LHR,ENG,SWE,,Company leader',
  reason: 'Preview initial employee import',
};

it('creates a strict CSV preview using only the selected session actor', async () => {
  methods.createEmployeeImportPreview.mockResolvedValueOnce({ id: batchId });
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .set('Idempotency-Key', requestKey)
    .send(body)
    .expect(201, { id: batchId });
  expect(methods.createEmployeeImportPreview).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    requestKey,
    body,
  );
});

it('reads only a UUID-addressed preview in the selected tenant', async () => {
  methods.readEmployeeImportPreview.mockResolvedValueOnce({ id: batchId });
  await request(app.getHttpServer())
    .get(`${path}/${batchId}`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .expect(200, { id: batchId });
  expect(methods.readEmployeeImportPreview).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    batchId,
  );
  await request(app.getHttpServer())
    .get(`${path}/not-a-uuid`)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .expect(400);
});

it('requires CSRF and rejects mass assignment or unsafe file names', async () => {
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Idempotency-Key', requestKey)
    .send(body)
    .expect(403);
  for (const invalid of [
    { ...body, tenantId },
    { ...body, status: 'ready' },
    { ...body, fileName: '../employees.csv' },
    { ...body, content: '' },
  ])
    await request(app.getHttpServer())
      .post(path)
      .set('Cookie', `__Host-kinto-session=${token}`)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', requestKey)
      .send(invalid)
      .expect(400);
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(body)
    .expect(400);
  expect(methods.createEmployeeImportPreview).not.toHaveBeenCalled();
});
