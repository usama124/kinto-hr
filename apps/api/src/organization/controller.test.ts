import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { OrganizationController } from './controller';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const entityId = randomUUID();
const branchId = randomUUID();
const policyId = randomUUID();
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
  readOrganization: vi.fn(),
  createLegalEntity: vi.fn(),
  updateLegalEntity: vi.fn(),
  createBranch: vi.fn(),
  updateBranch: vi.fn(),
  createOrganizationCatalogEntry: vi.fn(),
  updateOrganizationCatalogEntry: vi.fn(),
  createPolicyDraft: vi.fn(),
  previewPolicy: vi.fn(),
  publishPolicy: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [OrganizationController],
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

const base = `/api/v1/tenants/${tenantId}/organization`;
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

it('reads the selected organization with only the server-derived actor', async () => {
  methods.readOrganization.mockResolvedValueOnce({
    legalEntity: null,
    branches: [],
    departments: [],
    designations: [],
    latestPublishedVersion: 0,
    publishedPolicy: null,
    policyDrafts: [],
  });
  await authenticated('get', base).expect(200);
  expect(methods.readOrganization).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
});

it('creates and versions only department or designation catalog entries', async () => {
  const departmentId = randomUUID();
  const create = {
    code: 'ENG',
    name: 'Engineering',
    reason: 'Create engineering department',
  };
  methods.createOrganizationCatalogEntry.mockResolvedValueOnce({
    id: departmentId,
    version: 1,
  });
  await authenticated('post', `${base}/departments`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(create)
    .expect(201, { id: departmentId, version: 1 });
  expect(methods.createOrganizationCatalogEntry).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    'department',
    create,
  );

  const update = {
    expectedVersion: 1,
    code: 'SWE',
    name: 'Software Engineer',
    status: 'inactive',
    reason: 'Retire duplicate designation',
  };
  methods.updateOrganizationCatalogEntry.mockResolvedValueOnce({
    id: departmentId,
    version: 2,
  });
  await authenticated('put', `${base}/designations/${departmentId}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(update)
    .expect(200, { id: departmentId, version: 2 });
  expect(methods.updateOrganizationCatalogEntry).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    'designation',
    departmentId,
    update,
  );

  await authenticated('post', `${base}/teams`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(create)
    .expect(400);
  await authenticated('post', `${base}/departments`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send({ ...create, status: 'active' })
    .expect(400);
});

it('requires exact Origin and CSRF for legal entity and branch writes', async () => {
  const entity = {
    legalName: 'Synthetic Private Limited',
    provinceCode: 'PK-PB',
    reason: 'Initial legal setup',
  };
  await authenticated('post', `${base}/legal-entities`)
    .send(entity)
    .expect(403);
  methods.createLegalEntity.mockResolvedValueOnce({ id: entityId, version: 1 });
  await authenticated('post', `${base}/legal-entities`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(entity)
    .expect(201, { id: entityId, version: 1 });
  expect(methods.createLegalEntity).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    entity,
  );

  const branch = {
    expectedVersion: 1,
    code: 'LHR',
    name: 'Lahore',
    provinceCode: 'PK-PB',
    status: 'active',
    reason: 'Correct branch name',
  };
  methods.updateBranch.mockResolvedValueOnce({ id: branchId, version: 2 });
  await authenticated('put', `${base}/branches/${branchId}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(branch)
    .expect(200, { id: branchId, version: 2 });
});

it('validates typed policy inputs and passes stale MFA as unverified', async () => {
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  const draft = {
    expectedCurrentVersion: 0,
    effectiveFrom: '2026-09-07',
    settings: { defaultBranchId: branchId },
    reason: 'Set the default branch',
  };
  methods.createPolicyDraft.mockResolvedValueOnce({ id: policyId, version: 1 });
  await authenticated('post', `${base}/policies/organization-defaults/drafts`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send(draft)
    .expect(201);
  expect(methods.createPolicyDraft).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
    draft,
  );
  await authenticated('post', `${base}/policies/organization-defaults/drafts`)
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send({ ...draft, settings: { ...draft.settings, absenceRule: 'deduct' } })
    .expect(400);
});

it('previews and publishes only IDs in the selected tenant path', async () => {
  methods.previewPolicy.mockResolvedValueOnce({
    id: policyId,
    version: 1,
    basedOnVersion: 0,
    effectiveFrom: '2026-09-07',
    defaultBranch: { id: branchId, code: 'LHR', name: 'Lahore' },
    affectedOpenPeriods: [],
  });
  await authenticated(
    'get',
    `${base}/policies/organization-defaults/drafts/${policyId}/preview`,
  ).expect(200);
  methods.publishPolicy.mockResolvedValueOnce({ id: policyId, version: 1 });
  await authenticated(
    'post',
    `${base}/policies/organization-defaults/drafts/${policyId}/publication`,
  )
    .set('Origin', origin)
    .set('X-CSRF-Token', csrf)
    .send({ expectedVersion: 1, reason: 'Publish reviewed policy' })
    .expect(201);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('get', base).expect(403);
});
