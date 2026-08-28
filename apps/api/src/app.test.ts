import 'reflect-metadata';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';
import { DatabaseService } from './database.service';
import { configureHttp } from './http';
let app: INestApplication;
const ready = vi.fn().mockResolvedValue(undefined);
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue({ ready })
    .compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
it('returns safe liveness and security headers', async () => {
  const response = await request(app.getHttpServer())
    .get('/api/v1/health/live')
    .expect(200);
  expect(response.body).toEqual({ status: 'ok', service: 'kinto-api' });
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
});
it('checks readiness and hides dependency failures', async () => {
  await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
  ready.mockRejectedValueOnce(
    new Error('postgresql://secret:password@internal-host'),
  );
  const response = await request(app.getHttpServer())
    .get('/api/v1/health/ready')
    .expect(503);
  expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
  expect(JSON.stringify(response.body)).not.toMatch(
    /password|internal-host|stack/,
  );
});
it.each([
  '/api/v1/tenants/test/employees',
  '/api/v1/platform/tenants',
  '/api/v1/payroll',
  '/api/v1/auth/login',
])('keeps unfinished business endpoint %s closed', async (path) => {
  const response = await request(app.getHttpServer())
    .get(path)
    .set('X-Tenant-Id', 'forged')
    .expect(404);
  expect(response.body.code).toBe('NOT_FOUND');
  await request(app.getHttpServer())
    .post(path)
    .send({ role: 'owner' })
    .expect(404);
});
