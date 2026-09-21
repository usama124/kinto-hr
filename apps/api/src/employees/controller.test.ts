import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/service';
import { DatabaseService } from '../database.service';
import { configureHttp } from '../http';
import { EmployeesController } from './controller';

const origin = 'https://kinto.example';
const token = 'a'.repeat(43);
const csrf = 'b'.repeat(43);
const identityId = randomUUID();
const tenantId = randomUUID();
const employeeId = randomUUID();
const branchId = randomUUID();
const departmentId = randomUUID();
const designationId = randomUUID();
const taskId = randomUUID();
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
  readEmployees: vi.fn(),
  readEmployee: vi.fn(),
  readEmployeePrivateDetails: vi.fn(),
  createEmployee: vi.fn(),
  updateEmployeeProfile: vi.fn(),
  updateEmployeePrivateDetails: vi.fn(),
  readEmployeeCompensation: vi.fn(),
  reviseEmployeeCompensation: vi.fn(),
  readEmployeeChecklist: vi.fn(),
  createEmployeeChecklistTask: vi.fn(),
  completeEmployeeChecklistTask: vi.fn(),
  readEmployeeDocuments: vi.fn(),
  registerEmployeeDocument: vi.fn(),
  createEmployeeAssignment: vi.fn(),
  activateEmployee: vi.fn(),
  scheduleEmployeeTermination: vi.fn(),
  archiveEmployee: vi.fn(),
  rehireEmployee: vi.fn(),
};
const limit = vi.fn().mockResolvedValue(undefined);
const getSession = vi.fn().mockResolvedValue(session);
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [EmployeesController],
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

const base = `/api/v1/tenants/${tenantId}/employees`;
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
const mutation = (verb: 'post' | 'put', path: string) =>
  authenticated(verb, path).set('Origin', origin).set('X-CSRF-Token', csrf);

it('lists and reads employee records using only selected-tenant context', async () => {
  methods.readEmployees.mockResolvedValueOnce({ employees: [] });
  await authenticated('get', base).expect(200, { employees: [] });
  expect(methods.readEmployees).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
  );
  methods.readEmployee.mockResolvedValueOnce({ id: employeeId });
  await authenticated('get', `${base}/${employeeId}`).expect(200);
  expect(methods.readEmployee).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
  );
});

it('lists and registers only strict private document metadata', async () => {
  methods.readEmployeeDocuments.mockResolvedValueOnce({ documents: [] });
  await authenticated('get', `${base}/${employeeId}/documents`).expect(200, {
    documents: [],
  });
  expect(methods.readEmployeeDocuments).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
  );
  const key = randomUUID();
  const input = {
    category: 'employment',
    visibility: 'hr_only',
    fileName: 'contract.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    fileDigest: 'a'.repeat(64),
    expiresOn: null,
    replacementDocumentId: null,
    reason: 'Approved document registration',
  };
  methods.registerEmployeeDocument.mockResolvedValueOnce({
    id: randomUUID(),
    ...input,
    status: 'awaiting_upload',
  });
  await mutation('post', `${base}/${employeeId}/documents`)
    .set('Idempotency-Key', key)
    .send(input)
    .expect(201);
  expect(methods.registerEmployeeDocument).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    key,
    input,
  );
  await mutation('post', `${base}/${employeeId}/documents`)
    .set('Idempotency-Key', key)
    .send({ ...input, downloadUrl: 'https://evil.example/file' })
    .expect(400);
  await mutation('post', `${base}/${employeeId}/documents`)
    .send(input)
    .expect(400);
});

it('creates a strict complete draft and rejects salary or unsupported workers', async () => {
  const body = {
    employeeNumber: 'EMP-001',
    name: 'Sana Khan',
    joiningDate: '2026-09-08',
    employmentType: 'monthly_salaried',
    branchId,
    departmentId,
    designationId,
    managerEmployeeId: null,
    topLevelReason: 'Company chief executive',
    reason: 'Create employee record',
  };
  methods.createEmployee.mockResolvedValueOnce({ id: employeeId, version: 1 });
  await mutation('post', base)
    .send(body)
    .expect(201, { id: employeeId, version: 1 });
  expect(methods.createEmployee).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    body,
  );
  await mutation('post', base)
    .send({ ...body, salary: 100000 })
    .expect(400);
  await mutation('post', base)
    .send({ ...body, employmentType: 'daily_wage' })
    .expect(400);
});

it('versions public profiles and effective assignments behind CSRF', async () => {
  await authenticated('put', `${base}/${employeeId}`)
    .send({ expectedVersion: 1, name: 'Sana', reason: 'Correct name' })
    .expect(403);
  const profile = {
    expectedVersion: 1,
    name: 'Sana Ahmed',
    legalName: 'Sana Khan Ahmed',
    reason: 'Approved legal name correction',
  };
  methods.updateEmployeeProfile.mockResolvedValueOnce({
    id: employeeId,
    version: 2,
  });
  await mutation('put', `${base}/${employeeId}`).send(profile).expect(200);
  expect(methods.updateEmployeeProfile).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    profile,
  );
  const assignment = {
    expectedVersion: 2,
    effectiveFrom: '2026-10-01',
    branchId,
    departmentId,
    designationId,
    managerEmployeeId: null,
    topLevelReason: 'Executive reporting exception',
    reason: 'Approved future organization move',
  };
  methods.createEmployeeAssignment.mockResolvedValueOnce({
    id: employeeId,
    version: 3,
  });
  await mutation('post', `${base}/${employeeId}/assignments`)
    .send(assignment)
    .expect(201);
  expect(methods.createEmployeeAssignment).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    assignment,
  );
});

it('reads and versions private details on a separate strict route', async () => {
  methods.readEmployeePrivateDetails.mockResolvedValueOnce({ details: null });
  await authenticated('get', `${base}/${employeeId}/private-details`).expect(
    200,
    { details: null },
  );
  expect(methods.readEmployeePrivateDetails).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
  );
  const details = {
    expectedVersion: 0,
    personalEmail: 'person@example.com',
    mobilePhone: '+923001234567',
    residentialAddress: 'Lahore, Pakistan',
    emergencyContactName: 'Emergency Contact',
    emergencyContactPhone: '03007654321',
    cnic: '3520212345671',
    reason: 'Approved private details',
  };
  methods.updateEmployeePrivateDetails.mockResolvedValueOnce({
    id: randomUUID(),
    version: 1,
  });
  await mutation('put', `${base}/${employeeId}/private-details`)
    .send(details)
    .expect(200);
  expect(methods.updateEmployeePrivateDetails).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    details,
  );
  await mutation('put', `${base}/${employeeId}/private-details`)
    .send({ ...details, bankAccount: 'PK00FORBIDDEN' })
    .expect(400);
  await authenticated('put', `${base}/${employeeId}/private-details`)
    .send(details)
    .expect(403);
});

it('keeps typed compensation on a separate payroll-authorized route', async () => {
  methods.readEmployeeCompensation.mockResolvedValueOnce({ agreement: null });
  await authenticated('get', `${base}/${employeeId}/compensation`).expect(200, {
    agreement: null,
  });
  expect(methods.readEmployeeCompensation).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
  );
  const revision = {
    expectedAgreementVersion: 0,
    effectiveFrom: '2026-09-01',
    components: [
      {
        code: 'BASIC',
        name: 'Monthly basic salary',
        kind: 'basic_salary',
        monthlyAmount: '100000.00',
      },
    ],
    reason: 'Approved initial compensation',
  };
  methods.reviseEmployeeCompensation.mockResolvedValueOnce({
    id: randomUUID(),
    version: 1,
  });
  await mutation('post', `${base}/${employeeId}/compensation`)
    .send(revision)
    .expect(201);
  expect(methods.reviseEmployeeCompensation).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    revision,
  );
  await mutation('post', `${base}/${employeeId}/compensation`)
    .send({ ...revision, currencyCode: 'USD' })
    .expect(400);
  await mutation('post', `${base}/${employeeId}/compensation`)
    .send({ ...revision, components: [] })
    .expect(400);
});

it('reads, creates and completes strict employee checklist tasks', async () => {
  methods.readEmployeeChecklist.mockResolvedValueOnce({ tasks: [] });
  await authenticated('get', `${base}/${employeeId}/checklist`).expect(200, {
    tasks: [],
  });
  expect(methods.readEmployeeChecklist).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
  );
  const task = {
    lifecycle: 'onboarding',
    taskCode: 'COLLECT_DOCUMENTS',
    title: 'Collect signed documents',
    assigneeIdentityId: identityId,
    dueDate: '2026-09-20',
    reason: 'Prepare employee onboarding',
  };
  methods.createEmployeeChecklistTask.mockResolvedValueOnce({
    id: taskId,
    version: 1,
  });
  await mutation('post', `${base}/${employeeId}/checklist`)
    .send(task)
    .expect(201, { id: taskId, version: 1 });
  expect(methods.createEmployeeChecklistTask).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    task,
  );
  const completion = { expectedVersion: 1, reason: 'Documents verified' };
  methods.completeEmployeeChecklistTask.mockResolvedValueOnce({
    id: taskId,
    version: 2,
  });
  await mutation('post', `${base}/${employeeId}/checklist/${taskId}/complete`)
    .send(completion)
    .expect(201, { id: taskId, version: 2 });
  expect(methods.completeEmployeeChecklistTask).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    taskId,
    completion,
  );
  await mutation('post', `${base}/${employeeId}/checklist`)
    .send({ ...task, salary: '100000' })
    .expect(400);
});

it('activates a draft with an expected version, recent MFA and audit reason', async () => {
  const activation = {
    expectedVersion: 3,
    reason: 'Approved employee activation',
  };
  methods.activateEmployee.mockResolvedValueOnce({
    id: employeeId,
    version: 4,
    status: 'active',
  });
  await mutation('post', `${base}/${employeeId}/activate`)
    .send(activation)
    .expect(201, { id: employeeId, version: 4, status: 'active' });
  expect(methods.activateEmployee).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    activation,
  );
  await mutation('post', `${base}/${employeeId}/activate`)
    .send({ ...activation, employeeLimit: 250 })
    .expect(400);
});

it('schedules an active employee termination with a final working date', async () => {
  const termination = {
    expectedVersion: 4,
    finalWorkingDate: '2026-09-30',
    reason: 'Approved employee separation',
  };
  methods.scheduleEmployeeTermination.mockResolvedValueOnce({
    id: employeeId,
    version: 5,
    status: 'active',
  });
  await mutation('post', `${base}/${employeeId}/terminate`)
    .send(termination)
    .expect(201, { id: employeeId, version: 5, status: 'active' });
  expect(methods.scheduleEmployeeTermination).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    termination,
  );
  await mutation('post', `${base}/${employeeId}/terminate`)
    .send({ ...termination, revokeIdentity: true })
    .expect(400);
});

it('archives a terminated employee without accepting deletion controls', async () => {
  const archive = {
    expectedVersion: 5,
    reason: 'Approved historical employee archive',
  };
  methods.archiveEmployee.mockResolvedValueOnce({
    id: employeeId,
    version: 6,
    status: 'archived',
  });
  await mutation('post', `${base}/${employeeId}/archive`)
    .send(archive)
    .expect(201, { id: employeeId, version: 6, status: 'archived' });
  expect(methods.archiveEmployee).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    archive,
  );
  await mutation('post', `${base}/${employeeId}/archive`)
    .send({ ...archive, deleteHistory: true })
    .expect(400);
});

it('rehire appends a fresh assignment without accepting access restoration controls', async () => {
  const rehire = {
    expectedVersion: 6,
    joiningDate: '2026-10-01',
    branchId,
    departmentId,
    designationId,
    managerEmployeeId: null,
    topLevelReason: 'Approved top-level role',
    reason: 'Approved employee rehire',
  };
  methods.rehireEmployee.mockResolvedValueOnce({
    id: employeeId,
    version: 7,
    status: 'active',
  });
  await mutation('post', `${base}/${employeeId}/rehire`)
    .send(rehire)
    .expect(201, { id: employeeId, version: 7, status: 'active' });
  expect(methods.rehireEmployee).toHaveBeenCalledWith(
    { identityId, mfaVerified: true },
    tenantId,
    employeeId,
    rehire,
  );
  await mutation('post', `${base}/${employeeId}/rehire`)
    .send({ ...rehire, restoreAccess: true })
    .expect(400);
});

it('passes expired MFA as unverified and rejects forged tenant or employee IDs', async () => {
  getSession.mockResolvedValueOnce({ ...session, authTime: now - 301 });
  methods.readEmployees.mockResolvedValueOnce({ employees: [] });
  await authenticated('get', base).expect(200);
  expect(methods.readEmployees).toHaveBeenCalledWith(
    { identityId, mfaVerified: false },
    tenantId,
  );
  await authenticated('get', `${base}/not-a-uuid`).expect(400);
  getSession.mockResolvedValueOnce({
    ...session,
    selectedTenantId: randomUUID(),
  });
  await authenticated('get', base).expect(403);
});
