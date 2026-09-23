import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { DocumentUploadService } from './upload';
import { SelfDocumentsController } from './self-controller';
import { SelfProfileController } from '../employees/self-profile-controller';
import { ProfileChangeController } from '../employees/profile-change-controller';

const tenantId = randomUUID();
const documentId = randomUUID();
const identityId = randomUUID();
const token = 'a'.repeat(43);
const now = Math.floor(Date.now() / 1000);
const session = {
  identityId,
  selectedTenantId: tenantId,
  authTime: now,
  csrf: 'b'.repeat(43),
  expiresAt: now + 300,
  principal: { mfaVerified: true },
};
const list = vi.fn();
const readProfile = vi.fn();
const submitChange = vi.fn();
const listChanges = vi.fn();
const downloadSelf = vi.fn();
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [
      SelfDocumentsController,
      SelfProfileController,
      ProfileChangeController,
    ],
    providers: [
      {
        provide: AuthService,
        useValue: {
          limit: vi.fn().mockResolvedValue(undefined),
          session: getSession,
          origin: () => 'https://kinto.example',
        },
      },
      {
        provide: DatabaseService,
        useValue: {
          readSelfEmployeeDocuments: list,
          readSelfEmployeeProfile: readProfile,
          submitSelfProfileChangeRequest: submitChange,
          readSelfProfileChangeRequests: listChanges,
        },
      },
      { provide: DocumentUploadService, useValue: { downloadSelf } },
    ],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => app?.close());

const base = `/api/v1/tenants/${tenantId}/me/documents`;
const authenticated = (path: string) =>
  request(app.getHttpServer())
    .get(path)
    .set('Cookie', `__Host-kinto-session=${token}`);

it('lists only documents supplied by the self-service database boundary', async () => {
  list.mockResolvedValueOnce({ documents: [{ id: documentId }] });
  await authenticated(base).expect(200, {
    documents: [{ id: documentId }],
  });
  expect(list).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
  await request(app.getHttpServer()).get(base).expect(401);
  expect(list).toHaveBeenCalledTimes(1);
});

it('loads a selected-tenant read-only profile without an employee ID in the path', async () => {
  const profile = {
    employee: { id: randomUUID(), name: 'Linked Employee' },
    contact: null,
  };
  readProfile.mockResolvedValueOnce(profile);
  await authenticated(`/api/v1/tenants/${tenantId}/me/profile`).expect(
    200,
    profile,
  );
  expect(readProfile).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
  await authenticated(`/api/v1/tenants/${randomUUID()}/me/profile`).expect(403);
  await request(app.getHttpServer())
    .get(`/api/v1/tenants/${tenantId}/me/profile`)
    .expect(401);
  expect(readProfile).toHaveBeenCalledTimes(1);
});

it('submits only strict contact proposals with session CSRF and an idempotency key', async () => {
  const path = `/api/v1/tenants/${tenantId}/me/profile-change-requests`;
  const key = randomUUID();
  const input = {
    expectedContactVersion: 1,
    personalEmail: 'new@example.com',
    mobilePhone: '03001234567',
    emergencyContactName: 'Contact Person',
    emergencyContactPhone: '03007654321',
    reason: 'Update my contact details',
  };
  submitChange.mockResolvedValueOnce({ id: randomUUID(), status: 'pending' });
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', 'https://kinto.example')
    .set('X-CSRF-Token', session.csrf)
    .set('Idempotency-Key', key)
    .send(input)
    .expect(201);
  expect(submitChange).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    key,
    input,
  );
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Idempotency-Key', randomUUID())
    .send(input)
    .expect(403);
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', 'https://kinto.example')
    .set('X-CSRF-Token', session.csrf)
    .set('Idempotency-Key', randomUUID())
    .send({ ...input, cnic: '3520212345678' })
    .expect(400);
  await request(app.getHttpServer())
    .post(path)
    .set('Cookie', `__Host-kinto-session=${token}`)
    .set('Origin', 'https://kinto.example')
    .set('X-CSRF-Token', session.csrf)
    .send(input)
    .expect(400);
  expect(submitChange).toHaveBeenCalledTimes(1);
  listChanges.mockResolvedValueOnce({ requests: [] });
  await authenticated(path).expect(200, { requests: [] });
  expect(listChanges).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
});

it('serves an own document as a no-store attachment and rejects mismatched paths', async () => {
  const bytes = Buffer.from('%PDF-1.7\n%%EOF');
  downloadSelf.mockResolvedValueOnce({
    bytes,
    contentType: 'application/pdf',
  });
  const response = await authenticated(`${base}/${documentId}/content`).expect(
    200,
  );
  expect(response.body).toEqual(bytes);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-disposition']).toBe(
    `attachment; filename="document-${documentId}.pdf"`,
  );
  expect(downloadSelf).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    documentId,
  );
  await authenticated(`${base}/invalid/content`).expect(400);
  await authenticated(
    `/api/v1/tenants/${randomUUID()}/me/documents/${documentId}/content`,
  ).expect(403);
  expect(downloadSelf).toHaveBeenCalledTimes(1);
});
