import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createDatabase,
  inAuthorizedTenant,
  pendingProviderLogouts,
  providerSessionRevoked,
  providerLogoutHealth,
} from '@kinto/database';
import { AppModule } from '../../apps/api/src/app.module';
import { configureHttp } from '../../apps/api/src/http';
import {
  AuthStore,
  digest,
  opaqueToken,
  IDLE_SECONDS,
} from '../../apps/api/src/auth/store';
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
} from '../../apps/api/src/auth/controller';
import { OidcProvider } from '../../apps/api/src/auth/oidc';
import { AuthService } from '../../apps/api/src/auth/service';
import { DatabaseService } from '../../apps/api/src/database.service';
import { readAuthConfig } from '../../apps/api/src/auth/config';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (
  !adminUrl ||
  !runtimeUrl ||
  !redisUrl ||
  [adminUrl, runtimeUrl].some(
    (url) => !new URL(url).pathname.startsWith('/kinto_test'),
  ) ||
  !['127.0.0.1', 'localhost'].includes(new URL(redisUrl).hostname)
)
  throw new Error(
    'Auth integration requires synthetic test databases and loopback Redis',
  );
const admin = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const subject = randomUUID();
const tenantId = randomUUID();
const accountEmployeeId = randomUUID();
const origin = 'https://kinto.example';
const clientId = 'synthetic-kinto';
const clientSecret = 'synthetic-client-secret';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'synthetic',
  alg: 'RS256',
  use: 'sig',
};
let issuer: string;
let provider: Server;
let app: INestApplication;
let store: AuthStore;
let identityId: string;
const provisionedTenantIds: string[] = [];
let tokenRequests = 0;
let mode = 'valid';
let identityStatus = 'enabled';
const identityStatusCalls: string[] = [];

const codes = new Map<
  string,
  { nonce: string; challenge: string; mode: string; sid: string }
>();
let providerSessionId = 'synthetic-provider-session';
function cookies(response: { headers: Record<string, unknown> }, name: string) {
  const headers = response.headers['set-cookie'] as string[];
  return headers.find((header) => header.startsWith(`${name}=`))!.split(';')[0];
}
function handle(cookie: string) {
  return cookie.slice(cookie.indexOf('=') + 1);
}

beforeAll(async () => {
  // A deliberately synthetic protocol server: it has no passwords/login UI.
  // Real signed token validation, discovery, PKCE exchange, Redis and DB run below.
  provider = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    res.setHeader('Content-Type', 'application/json');
    const path = url.pathname.replace(/^\/realms\/synthetic/, '');
    if (url.pathname === '/realms/synthetic/protocol/openid-connect/token') {
      identityStatusCalls.push('token');
      if (
        req.headers.authorization !==
        `Basic ${Buffer.from('status-reader:synthetic-status-secret').toString('base64')}`
      ) {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (identityStatus === 'token-outage') {
        res.statusCode = 503;
        return res.end('{}');
      }
      return res.end(
        JSON.stringify({
          access_token: 'synthetic-status-reader-token',
          token_type: 'Bearer',
          expires_in: 60,
        }),
      );
    }
    if (url.pathname.startsWith('/admin/realms/synthetic/users/')) {
      identityStatusCalls.push(req.method!);
      if (
        req.method !== 'GET' ||
        req.headers.authorization !== 'Bearer synthetic-status-reader-token'
      ) {
        res.statusCode = 403;
        return res.end('{}');
      }
      if (identityStatus === 'outage' || identityStatus === 'missing') {
        res.statusCode = identityStatus === 'missing' ? 404 : 503;
        return res.end('{}');
      }
      return res.end(
        JSON.stringify({
          id:
            identityStatus === 'mismatched'
              ? 'other-subject'
              : decodeURIComponent(url.pathname.split('/').at(-1)!),
          enabled:
            identityStatus === 'malformed'
              ? 'true'
              : identityStatus !== 'disabled',
        }),
      );
    }
    if (path === '/.well-known/openid-configuration') {
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    }
    if (path === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (path === '/authorize') {
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        mode,
        sid: providerSessionId,
      });
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', code);
      res.writeHead(302, { Location: callback.href });
      return res.end();
    }
    if (path === '/token') {
      tokenRequests++;
      let body = '';
      for await (const part of req) body += part;
      const form = new URLSearchParams(body);
      const code = form.get('code')!;
      const grant = codes.get(code);
      codes.delete(code);
      if (
        !grant ||
        form.get('client_secret') !== clientSecret ||
        form.get('client_id') !== clientId ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('redirect_uri') !== `${origin}/api/v1/auth/callback` ||
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') !== grant.challenge
      ) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: issuer,
        aud: clientId,
        sub: subject,
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        auth_time: now,
        sid: grant.sid,
        acr: 'mfa',
        amr: ['pwd', 'otp'],
        roles: ['owner'],
      };
      if (grant.mode === 'issuer') claims.iss = 'https://attacker.example';
      if (grant.mode === 'audience') claims.aud = 'another-client';
      if (grant.mode === 'nonce') claims.nonce = 'incorrect';
      if (grant.mode === 'expired') claims.exp = now - 60;
      if (grant.mode === 'recent-before-logout') claims.auth_time = now - 30;
      if (grant.mode === 'stale-auth') claims.auth_time = now - 600;
      if (grant.mode === 'future-auth') claims.auth_time = now + 600;
      if (grant.mode === 'unknown') claims.sub = 'not-provisioned';
      if (grant.mode === 'loa2') claims.acr = '2';
      if (grant.mode === 'loa1') claims.acr = '1';
      if (grant.mode === 'numeric-loa') claims.acr = 2;
      if (grant.mode === 'no-acr') delete claims.acr;
      const header = Buffer.from(
        JSON.stringify({
          alg: grant.mode === 'algorithm' ? 'HS256' : 'RS256',
          kid: 'synthetic',
        }),
      ).toString('base64url');
      const payload = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
      const signature = sign('RSA-SHA256', Buffer.from(payload), privateKey);
      if (grant.mode === 'signature') signature[0] ^= 1;
      return res.end(
        JSON.stringify({
          access_token: 'synthetic-access-not-stored',
          token_type: 'Bearer',
          expires_in: 300,
          ...(grant.mode === 'no-id-token'
            ? {}
            : { id_token: `${payload}.${signature.toString('base64url')}` }),
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not start');
  issuer = `http://127.0.0.1:${address.port}/realms/synthetic`;
  for (const [key, value] of Object.entries({
    IDENTITY_STATUS_MODE: 'disabled',
    AUTH_LOGOUT_MODE: 'synchronous',
    AUTH_MODE: 'oidc',
    NODE_ENV: 'test',
    AUTH_ORIGIN: origin,
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_MFA_PROFILE: 'none',
    AUTH_REDIS_URL: redisUrl,
  }))
    vi.stubEnv(key, value);
  store = new AuthStore(
    redisUrl!,
    `kinto:auth:v2:${digest(`${issuer}|${clientId}|${origin}`)}:`,
  );
  await store.connect();
  const identity = await admin.identity.create({ data: { issuer, subject } });
  identityId = identity.id;
  await admin.platformOperator.create({ data: { identityId } });
  await admin.tenant.create({
    data: { id: tenantId, name: 'Synthetic auth company', employeeLimit: 5 },
  });
  await admin.membership.create({
    data: { tenantId, identityId, roles: ['owner'] },
  });
  await admin.employee.create({
    data: {
      id: accountEmployeeId,
      tenantId,
      employeeNumber: 'account-fixture',
      name: 'Synthetic account fixture',
    },
  });
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});
beforeEach(async () => {
  await admin.authProviderLogoutEvent.deleteMany({
    where: { namespace: digest(`${issuer}|${clientId}|${origin}`) },
  });
  mode = 'valid';
  identityStatus = 'enabled';
  identityStatusCalls.length = 0;
  providerSessionId = 'synthetic-provider-session';
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1'])
    await store.redis.del(store.key('rate', ip));
  await admin.identity.update({
    where: { id: identityId },
    data: { status: 'active' },
  });
  await admin.membership.updateMany({
    where: { tenantId },
    data: { status: 'active' },
  });
});
afterAll(async () => {
  await app?.close();
  await admin.authProviderLogoutEvent.deleteMany({
    where: { namespace: digest(`${issuer}|${clientId}|${origin}`) },
  });
  if (store) {
    // Only fixture-specific keys; never FLUSHDB or shared application cleanup.
    const keys = await store.redis.keys(
      `kinto:auth:v2:${digest(`${issuer}|${clientId}|${origin}`)}:*`,
    );
    if (keys.length) await store.redis.del(...keys);
    store.close();
  }
  await admin.platformAuditEvent.deleteMany({ where: { actorId: identityId } });
  await admin.auditEvent.deleteMany({
    where: { tenantId: { in: provisionedTenantIds } },
  });
  await admin.companyProvisioningRequest.deleteMany({
    where: { tenantId: { in: provisionedTenantIds } },
  });
  await admin.tenant.deleteMany({
    where: { id: { in: provisionedTenantIds } },
  });
  await admin.platformOperator.deleteMany({ where: { identityId } });
  await admin.employeeAccountRequest.deleteMany({ where: { tenantId } });
  await admin.auditEvent.deleteMany({
    where: { tenantId, action: 'employee.account_provisioning_requested' },
  });
  await admin.membership.deleteMany({ where: { tenantId } });
  await admin.employee.deleteMany({ where: { tenantId } });
  await admin.tenant.deleteMany({ where: { id: tenantId } });
  await admin.identity.deleteMany({ where: { issuer, subject } });
  await Promise.all([admin.$disconnect(), runtime.$disconnect()]);
  if (provider)
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  vi.unstubAllEnvs();
});

async function begin() {
  const start = await request(app.getHttpServer())
    .get('/api/v1/auth/login?returnTo=https://attacker.example')
    .set('Host', 'attacker.example')
    .set('X-Forwarded-Host', 'attacker.example')
    .expect(302);
  const url = new URL(start.headers.location);
  expect(url.searchParams.get('redirect_uri')).toBe(
    `${origin}/api/v1/auth/callback`,
  );
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('scope')).toBe('openid');
  expect(url.searchParams.get('response_type')).toBe('code');
  const authorize = await fetch(url, { redirect: 'manual' });
  const callback = new URL(authorize.headers.get('location')!);
  return {
    start,
    cookie: cookies(start, LOGIN_COOKIE),
    query: callback.search,
  };
}
async function login(oldCookie?: string) {
  const transaction = await begin();
  const response = await request(app.getHttpServer())
    .get(`/api/v1/auth/callback${transaction.query}`)
    .set('Cookie', [transaction.cookie, ...(oldCookie ? [oldCookie] : [])])
    .expect(303);
  expect(response.headers.location).toBe(`${origin}/login`);
  return {
    ...transaction,
    response,
    sessionCookie: cookies(response, SESSION_COOKIE),
  };
}
function logoutToken(input: {
  jti?: string;
  sid?: string;
  sub?: string;
  variant?:
    | 'algorithm'
    | 'audience'
    | 'issuer'
    | 'nonce'
    | 'stale'
    | 'future'
    | 'events'
    | 'signature';
}) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: input.variant === 'issuer' ? 'https://attacker.example' : issuer,
    aud: input.variant === 'audience' ? 'another-client' : clientId,
    iat:
      input.variant === 'stale'
        ? now - 600
        : input.variant === 'future'
          ? now + 600
          : now,
    jti: input.jti ?? randomUUID(),
    ...(input.sid ? { sid: input.sid } : {}),
    ...(input.sub ? { sub: input.sub } : {}),
    events:
      input.variant === 'events'
        ? { 'https://attacker.example/event': {} }
        : { 'http://schemas.openid.net/event/backchannel-logout': {} },
    ...(input.variant === 'nonce' ? { nonce: 'prohibited' } : {}),
  };
  const header = Buffer.from(
    JSON.stringify({
      alg: input.variant === 'algorithm' ? 'none' : 'RS256',
      kid: 'synthetic',
      typ: 'logout+jwt',
    }),
  ).toString('base64url');
  const payload = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const signature = sign('RSA-SHA256', Buffer.from(payload), privateKey);
  if (input.variant === 'signature') signature[0] ^= 1;
  return `${payload}.${signature.toString('base64url')}`;
}
it('authenticates a provisioned identity with signed OIDC and returns only safe session data', async () => {
  const result = await login();
  const rawCookie = (
    result.response.headers['set-cookie'] as unknown as string[]
  ).find((value) => value.startsWith(SESSION_COOKIE))!;
  expect(rawCookie).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(rawCookie).toContain('Path=/');
  expect(rawCookie).not.toContain('Domain=');
  const response = await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', result.sessionCookie)
    .expect(200);
  expect(Object.keys(response.body).sort()).toEqual([
    'csrfToken',
    'expiresAt',
    'identityId',
    'selectedTenantId',
    'tenants',
  ]);
  expect(response.body.identityId).toBe(identityId);
  expect(response.body.selectedTenantId).toBe(tenantId);
  expect(response.body.tenants).toEqual([
    {
      id: tenantId,
      name: 'Synthetic auth company',
      roles: ['owner'],
    },
  ]);
  expect(response.headers['cache-control']).toBe('no-store');
  const session = await store.readSession(handle(result.sessionCookie));
  expect(session?.principal).toEqual({ issuer, subject, mfaVerified: false });
  expect(JSON.stringify(session)).not.toContain('synthetic-access-not-stored');
  await expect(
    inAuthorizedTenant(
      runtime,
      session!.principal,
      tenantId,
      'employees.read',
      async () => true,
    ),
  ).rejects.toThrow('FORBIDDEN');
});
it('discovers active companies, requires CSRF selection and clears revoked context', async () => {
  const secondTenantId = randomUUID();
  await admin.tenant.create({
    data: {
      id: secondTenantId,
      name: 'Another synthetic company',
      employeeLimit: 5,
    },
  });
  await admin.membership.create({
    data: {
      tenantId: secondTenantId,
      identityId,
      roles: ['hr_admin'],
    },
  });
  try {
    const result = await login();
    const token = handle(result.sessionCookie);
    const initial = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', result.sessionCookie)
      .expect(200);
    expect(initial.body.selectedTenantId).toBeNull();
    expect(
      initial.body.tenants.map((tenant: { id: string }) => tenant.id),
    ).toEqual([secondTenantId, tenantId]);
    await request(app.getHttpServer())
      .put('/api/v1/auth/tenant')
      .set('Cookie', result.sessionCookie)
      .set('Origin', 'https://attacker.example')
      .set('X-CSRF-Token', initial.body.csrfToken)
      .send({ tenantId: secondTenantId })
      .expect(403);
    await request(app.getHttpServer())
      .put('/api/v1/auth/tenant')
      .set('Cookie', result.sessionCookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', initial.body.csrfToken)
      .send({ tenantId: secondTenantId, roles: ['owner'] })
      .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/auth/tenant')
      .set('Cookie', result.sessionCookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', initial.body.csrfToken)
      .send({ tenantId: randomUUID() })
      .expect(403);
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        request(app.getHttpServer())
          .put('/api/v1/auth/tenant')
          .set('Cookie', result.sessionCookie)
          .set('Origin', origin)
          .set('X-CSRF-Token', initial.body.csrfToken)
          .send({ tenantId: secondTenantId }),
      ),
    );
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 403,
    ]);
    const selected = concurrent.find((response) => response.status === 200)!;
    expect(selected.body.selectedTenantId).toBe(secondTenantId);
    expect(selected.body.csrfToken).not.toBe(initial.body.csrfToken);
    expect((await store.readSession(token))?.selectedTenantId).toBe(
      secondTenantId,
    );
    await request(app.getHttpServer())
      .put('/api/v1/auth/tenant')
      .set('Cookie', result.sessionCookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', initial.body.csrfToken)
      .send({ tenantId })
      .expect(403);
    await admin.membership.update({
      where: {
        tenantId_identityId: { tenantId: secondTenantId, identityId },
      },
      data: { status: 'revoked' },
    });
    const cleared = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', result.sessionCookie)
      .expect(200);
    expect(cleared.body.selectedTenantId).toBeNull();
    expect(
      cleared.body.tenants.map((tenant: { id: string }) => tenant.id),
    ).toEqual([tenantId]);
    expect(cleared.body.csrfToken).not.toBe(selected.body.csrfToken);
  } finally {
    await admin.membership.deleteMany({ where: { tenantId: secondTenantId } });
    await admin.tenant.delete({ where: { id: secondTenantId } });
  }
});
it.each([
  'issuer',
  'audience',
  'nonce',
  'expired',
  'signature',
  'algorithm',
  'stale-auth',
  'future-auth',
  'no-id-token',
  'unknown',
])(
  'rejects %s tokens without provisioning or leaking credentials',
  async (variant) => {
    mode = variant;
    const transaction = await begin();
    const response = await request(app.getHttpServer())
      .get(`/api/v1/auth/callback${transaction.query}`)
      .set('Cookie', transaction.cookie)
      .expect(401);
    expect(JSON.stringify(response.body)).not.toMatch(
      /synthetic-client-secret|synthetic-access|stack|nonce/,
    );
    expect(
      (response.headers['set-cookie'] as unknown as string[]).some((value) =>
        value.startsWith(SESSION_COOKIE),
      ),
    ).toBe(false);
    expect(await admin.identity.count({ where: { issuer } })).toBe(1);
    expect(await admin.membership.count({ where: { tenantId } })).toBe(1);
  },
);
it('binds callback state to the initiating browser and consumes it once', async () => {
  const transaction = await begin();
  await request(app.getHttpServer())
    .get(`/api/v1/auth/callback${transaction.query}`)
    .expect(401);
  const before = tokenRequests;
  await request(app.getHttpServer())
    .get('/api/v1/auth/callback?state=wrong&code=wrong')
    .set('Cookie', transaction.cookie)
    .expect(401);
  expect(tokenRequests).toBe(before);
  await request(app.getHttpServer())
    .get(`/api/v1/auth/callback${transaction.query}`)
    .set('Cookie', transaction.cookie)
    .expect(401);
  const valid = await login();
  await request(app.getHttpServer())
    .get(`/api/v1/auth/callback${valid.query}`)
    .set('Cookie', valid.cookie)
    .expect(401);
});
it('expires login transactions and prevents concurrent callback replay', async () => {
  const expired = await begin();
  await store.redis.pexpire(store.key('login', handle(expired.cookie)), 0);
  await request(app.getHttpServer())
    .get(`/api/v1/auth/callback${expired.query}`)
    .set('Cookie', expired.cookie)
    .expect(401);
  const pending = await begin();
  const responses = await Promise.all(
    [0, 1].map(() =>
      request(app.getHttpServer())
        .get(`/api/v1/auth/callback${pending.query}`)
        .set('Cookie', pending.cookie),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    303, 401,
  ]);
});
it('rejects missing, forged and duplicate cookies and never accepts bearer/header identity', async () => {
  for (const cookie of [
    '',
    `${SESSION_COOKIE}=forged`,
    `${SESSION_COOKIE}=${opaqueToken()}`,
    `${SESSION_COOKIE}=${opaqueToken()}; ${SESSION_COOKIE}=${opaqueToken()}`,
  ]) {
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .set('Authorization', 'Bearer fake')
      .set('X-Identity-Subject', subject)
      .expect(401);
  }
});
it('rotates the session on login and requires both origin and CSRF token on logout', async () => {
  const first = await login();
  const next = await login(first.sessionCookie);
  expect(next.sessionCookie).not.toBe(first.sessionCookie);
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', first.sessionCookie)
    .expect(401);
  const session = await store.readSession(handle(next.sessionCookie));
  for (const [requestOrigin, csrf] of [
    ['https://attacker.example', session!.csrf],
    [origin, 'incorrect'],
    ['', session!.csrf],
  ]) {
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', next.sessionCookie)
      .set('Origin', requestOrigin)
      .set('X-CSRF-Token', csrf)
      .expect(403);
  }
  await request(app.getHttpServer())
    .post('/api/v1/auth/logout')
    .set('Cookie', next.sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', session!.csrf)
    .expect(204);
  expect(await store.readSession(handle(next.sessionCookie))).toBeUndefined();
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', next.sessionCookie)
    .expect(401);
});
it('accepts signed back-channel logout once and revokes the targeted provider sessions atomically', async () => {
  providerSessionId = 'provider-session-one';
  const first = await login();
  const second = await login();
  providerSessionId = 'provider-session-two';
  const other = await login();
  const event = logoutToken({ sid: 'provider-session-one' });
  await request(app.getHttpServer())
    .post('/api/v1/auth/backchannel-logout')
    .type('form')
    .send({ logout_token: event })
    .expect(204);
  for (const sessionCookie of [first.sessionCookie, second.sessionCookie])
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', sessionCookie)
      .expect(401);
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', other.sessionCookie)
    .expect(200);
  await request(app.getHttpServer())
    .post('/api/v1/auth/backchannel-logout')
    .type('form')
    .send({ logout_token: event })
    .expect(204);
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', other.sessionCookie)
    .expect(200);
  await request(app.getHttpServer())
    .post('/api/v1/auth/backchannel-logout')
    .type('form')
    .send({ logout_token: logoutToken({ sub: subject }) })
    .expect(204);
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', other.sessionCookie)
    .expect(401);
});
it.each([
  'audience',
  'algorithm',
  'issuer',
  'nonce',
  'stale',
  'future',
  'events',
  'signature',
] as const)(
  'rejects %s back-channel logout tokens without deleting a session',
  async (variant) => {
    const active = await login();
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/backchannel-logout')
      .type('form')
      .send({
        logout_token: logoutToken({
          sid: providerSessionId,
          variant,
        }),
      })
      .expect(401);
    expect(JSON.stringify(response.body)).not.toMatch(/logout_token|jti|sid/);
    await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', active.sessionCookie)
      .expect(200);
  },
);
it('rejects malformed or untargeted back-channel requests', async () => {
  for (const body of [
    {},
    { logout_token: 'not-a-jwt' },
    { logout_token: 'x'.repeat(16385) },
    { logout_token: logoutToken({}) },
  ])
    await request(app.getHttpServer())
      .post('/api/v1/auth/backchannel-logout')
      .type('form')
      .send(body)
      .expect(401);
});
it('enforces idle and absolute expiration, including concurrent reads after deletion', async () => {
  const result = await login();
  const token = handle(result.sessionCookie);
  const key = store.key('session', token);
  await store.redis.expire(key, 10);
  expect(await store.readSession(token)).toBeDefined();
  expect(await store.redis.ttl(key)).toBeGreaterThan(IDLE_SECONDS - 2);
  const session = (await store.readSession(token))!;
  await store.redis.set(
    key,
    JSON.stringify({ ...session, expiresAt: 1 }),
    'EX',
    IDLE_SECONDS,
  );
  expect(await store.readSession(token)).toBeUndefined();
  const again = await login();
  await store.redis.pexpire(
    store.key('session', handle(again.sessionCookie)),
    0,
  );
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', again.sessionCookie)
    .expect(401);
  const last = await login();
  const lastToken = handle(last.sessionCookie);
  await Promise.all([
    store.readSession(lastToken),
    store.deleteSession(lastToken),
    store.readSession(lastToken),
  ]);
  expect(await store.readSession(lastToken)).toBeUndefined();
});
it('rechecks disabled identities and never restores revoked memberships during login', async () => {
  const result = await login();
  await admin.identity.update({
    where: { id: identityId },
    data: { status: 'disabled' },
  });
  await request(app.getHttpServer())
    .get('/api/v1/auth/session')
    .set('Cookie', result.sessionCookie)
    .expect(401);
  const transaction = await begin();
  await request(app.getHttpServer())
    .get(`/api/v1/auth/callback${transaction.query}`)
    .set('Cookie', transaction.cookie)
    .expect(401);
  await admin.identity.update({
    where: { id: identityId },
    data: { status: 'active' },
  });
  await admin.membership.updateMany({
    where: { tenantId },
    data: { status: 'revoked' },
  });
  const again = await login();
  const session = (await store.readSession(handle(again.sessionCookie)))!;
  await expect(
    inAuthorizedTenant(
      runtime,
      session.principal,
      tenantId,
      'employees.read',
      async () => true,
    ),
  ).rejects.toThrow('FORBIDDEN');
  expect(
    (await admin.membership.findFirstOrThrow({ where: { tenantId } })).status,
  ).toBe('revoked');
});
it('keeps public registration closed even when login is enabled', async () => {
  const result = await login();
  for (const path of ['/api/v1/auth/signup', '/api/v1/auth/register'])
    await request(app.getHttpServer())
      .post(path)
      .set('Cookie', result.sessionCookie)
      .send({ role: 'owner' })
      .expect(404);
});
it('allows only an MFA-verified active platform operator to request a company idempotently', async () => {
  const body = {
    companyName: 'HTTP Provisioned Company',
    employeeLimit: 20,
    billingMode: 'complimentary',
    initialOwnerEmail: 'Owner@Synthetic.Example',
  };
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Origin', origin)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(401);
  const ordinaryLogin = await login();
  const ordinarySession = (await store.readSession(
    handle(ordinaryLogin.sessionCookie),
  ))!;
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', ordinaryLogin.sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', ordinarySession.csrf)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);

  const staleMfa = await store.createSession({
    principal: { issuer, subject, mfaVerified: true },
    identityId,
    authTime: Math.floor(Date.now() / 1000) - 301,
  });
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', `${SESSION_COOKIE}=${staleMfa.token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', staleMfa.session.csrf)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);

  const elevated = await store.createSession({
    principal: { issuer, subject, mfaVerified: true },
    identityId,
    authTime: Math.floor(Date.now() / 1000),
  });
  const sessionCookie = `${SESSION_COOKIE}=${elevated.token}`;
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', 'not-a-uuid')
    .send(body)
    .expect(400);

  const key = randomUUID();
  const created = await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', key)
    .send(body)
    .expect(202);
  provisionedTenantIds.push(created.body.tenantId);
  expect(created.body).toMatchObject({
    status: 'pending_identity_provider',
    replayed: false,
  });
  expect(JSON.stringify(created.body)).not.toContain('Owner@');
  const replay = await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', key)
    .send(body)
    .expect(202);
  expect(replay.body).toEqual({ ...created.body, replayed: true });
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', key)
    .send({ ...body, employeeLimit: 50 })
    .expect(409);

  await admin.platformOperator.update({
    where: { identityId },
    data: { status: 'revoked', version: { increment: 1 } },
  });
  await request(app.getHttpServer())
    .post('/api/v1/platform/tenants')
    .set('Cookie', sessionCookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);
  await admin.platformOperator.update({
    where: { identityId },
    data: { status: 'active' },
  });
});
it('allows only a recent-MFA owner or HR to request an employee account', async () => {
  const route = `/api/v1/tenants/${tenantId}/employees/${accountEmployeeId}/account-invitations`;
  const body = { email: ' Employee@Synthetic.Example ' };
  await request(app.getHttpServer())
    .post(route)
    .set('Origin', origin)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(401);

  const stale = await store.createSession({
    principal: { issuer, subject, mfaVerified: true },
    identityId,
    authTime: Math.floor(Date.now() / 1000) - 301,
    selectedTenantId: tenantId,
  });
  await request(app.getHttpServer())
    .post(route)
    .set('Cookie', `${SESSION_COOKIE}=${stale.token}`)
    .set('Origin', origin)
    .set('X-CSRF-Token', stale.session.csrf)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);

  const elevated = await store.createSession({
    principal: { issuer, subject, mfaVerified: true },
    identityId,
    authTime: Math.floor(Date.now() / 1000),
    selectedTenantId: tenantId,
  });
  const cookie = `${SESSION_COOKIE}=${elevated.token}`;
  await request(app.getHttpServer())
    .post(route)
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('Idempotency-Key', randomUUID())
    .send(body)
    .expect(403);
  await request(app.getHttpServer())
    .post(route)
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', randomUUID())
    .send({ ...body, roles: ['owner'] })
    .expect(400);

  const key = randomUUID();
  const created = await request(app.getHttpServer())
    .post(route)
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', key)
    .send(body)
    .expect(202);
  expect(created.body).toMatchObject({
    status: 'pending_identity_provider',
    replayed: false,
  });
  expect(Object.keys(created.body).sort()).toEqual([
    'accountRequestId',
    'replayed',
    'status',
  ]);
  expect(JSON.stringify(created.body)).not.toContain('Employee@');
  const replay = await request(app.getHttpServer())
    .post(route)
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', key)
    .send({ email: 'employee@synthetic.example' })
    .expect(202);
  expect(replay.body).toEqual({ ...created.body, replayed: true });
  await request(app.getHttpServer())
    .post(route)
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', key)
    .send({ email: 'changed@synthetic.example' })
    .expect(409);

  await admin.membership.updateMany({
    where: { tenantId, identityId },
    data: { roles: ['employee'] },
  });
  await request(app.getHttpServer())
    .post(
      `/api/v1/tenants/${tenantId}/employees/${randomUUID()}/account-invitations`,
    )
    .set('Cookie', cookie)
    .set('Origin', origin)
    .set('X-CSRF-Token', elevated.session.csrf)
    .set('Idempotency-Key', randomUUID())
    .send({ email: 'denied@synthetic.example' })
    .expect(403);
  await admin.membership.updateMany({
    where: { tenantId, identityId },
    data: { roles: ['owner'] },
  });
});
it('rate-limits auth requests without trusting forwarded IPs', async () => {
  const allowed = await Promise.all(
    Array.from({ length: 61 }, () => store.allow('synthetic-rate-fixture')),
  );
  expect(allowed.filter(Boolean)).toHaveLength(60);
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1'])
    await store.redis.set(store.key('rate', ip), '60', 'EX', 60);
  await request(app.getHttpServer())
    .get('/api/v1/auth/login')
    .set('X-Forwarded-For', '203.0.113.7')
    .expect(429);
});
it('fails closed if discovery fails or Redis is unavailable', async () => {
  const config = readAuthConfig(process.env)!;
  await expect(
    OidcProvider.connect({ ...config, issuer: `${issuer}/missing` }),
  ).rejects.toThrow();
  const disconnected = new AuthStore(redisUrl!);
  await expect(disconnected.readSession(opaqueToken())).rejects.toThrow();
  disconnected.close();
});

it('reports failed auth readiness and never returns a session on a store error', async () => {
  const result = await login();
  const readiness = vi
    .spyOn(AuthStore.prototype, 'ready')
    .mockRejectedValueOnce(new Error('private-redis-secret'));
  try {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('private-redis-secret');
  } finally {
    readiness.mockRestore();
  }
  const read = vi
    .spyOn(AuthStore.prototype, 'readSession')
    .mockRejectedValueOnce(new Error('private-session-secret'));
  try {
    const response = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', result.sessionCookie)
      .expect(500);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-session-secret|csrfToken|identityId/,
    );
  } finally {
    read.mockRestore();
  }
});

async function directGrant(profile: 'none' | 'keycloak-loa2-v1') {
  const oidc = await OidcProvider.connect({
    ...readAuthConfig(process.env)!,
    mfaProfile: profile,
  });
  const started = await oidc.begin();
  if (profile !== 'none')
    expect(
      JSON.parse(new URL(started.url).searchParams.get('claims')!),
    ).toEqual({ id_token: { acr: { essential: true, values: ['2'] } } });
  const response = await fetch(started.url, { redirect: 'manual' });
  return oidc.complete(
    new URL(response.headers.get('location')!),
    started.transaction,
  );
}
it('requires explicit MFA profile opt-in even for a signed LoA 2 token', async () => {
  mode = 'loa2';
  expect((await directGrant('none')).principal.mfaVerified).toBe(false);
  expect((await directGrant('keycloak-loa2-v1')).principal.mfaVerified).toBe(
    true,
  );
});
it.each(['loa1', 'numeric-loa', 'no-acr', 'valid'])(
  'rejects %s assurance under the Keycloak MFA profile',
  async (variant) => {
    mode = variant;
    await expect(directGrant('keycloak-loa2-v1')).rejects.toThrow();
  },
);

async function withIdentityStatusApp(
  work: (guarded: INestApplication) => Promise<void>,
) {
  const values = {
    IDENTITY_STATUS_MODE: 'keycloak',
    OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
    KEYCLOAK_IDENTITY_STATUS_CLIENT_ID: 'status-reader',
    KEYCLOAK_IDENTITY_STATUS_CLIENT_SECRET: 'synthetic-status-secret',
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  let guarded: INestApplication | undefined;
  try {
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    mode = 'loa2';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    guarded = module.createNestApplication();
    configureHttp(guarded);
    await guarded.init();
    await work(guarded);
  } finally {
    await guarded?.close();
    for (const [key, value] of Object.entries(previous)) vi.stubEnv(key, value);
  }
}
async function statusLogin(guarded: INestApplication, expectedStatus = 303) {
  const begin = await request(guarded.getHttpServer())
    .get('/api/v1/auth/login')
    .expect(302);
  const authorized = await fetch(begin.headers.location, {
    redirect: 'manual',
  });
  const callback = new URL(authorized.headers.get('location')!);
  return request(guarded.getHttpServer())
    .get(`${callback.pathname}${callback.search}`)
    .set('Cookie', cookies(begin, LOGIN_COOKIE))
    .expect(expectedStatus);
}

it('rejects provider-disabled login and revokes every same-identity session without touching another identity or company records', async () => {
  await withIdentityStatusApp(async (guarded) => {
    const first = cookies(await statusLogin(guarded), SESSION_COOKIE);
    providerSessionId = 'synthetic-second-provider-session';
    const second = cookies(await statusLogin(guarded), SESSION_COOKIE);
    const other = await store.createSession({
      principal: {
        issuer,
        subject: 'synthetic-other-subject',
        mfaVerified: true,
      },
      identityId: randomUUID(),
      providerSessionId: 'unrelated-session',
      authTime: Math.floor(Date.now() / 1000),
    });
    const otherIssuer = await store.createSession({
      principal: {
        issuer: 'https://other.synthetic.example/realms/synthetic',
        subject,
        mfaVerified: true,
      },
      identityId: randomUUID(),
      authTime: Math.floor(Date.now() / 1000),
    });
    identityStatus = 'disabled';
    const revokeFailure = vi
      .spyOn(AuthStore.prototype, 'revokeProviderSessions')
      .mockRejectedValueOnce(new Error('synthetic revocation outage'));
    try {
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', first)
        .expect(503);
      expect(await store.readSession(handle(first))).toBeDefined();
    } finally {
      revokeFailure.mockRestore();
    }
    await request(guarded.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', first)
      .expect(401);
    expect(await store.readSession(handle(first))).toBeUndefined();
    expect(await store.readSession(handle(second))).toBeUndefined();
    expect(await store.readSession(other.token)).toBeDefined();
    expect(await store.readSession(otherIssuer.token)).toBeDefined();
    await store.deleteSession(otherIssuer.token);
    await store.deleteSession(other.token);
    await statusLogin(guarded, 401);
    expect(
      (await admin.identity.findUniqueOrThrow({ where: { id: identityId } }))
        .status,
    ).toBe('active');
    expect(
      (
        await admin.membership.findUniqueOrThrow({
          where: { tenantId_identityId: { tenantId, identityId } },
        })
      ).status,
    ).toBe('active');
    expect(
      identityStatusCalls
        .filter((method) => method !== 'token')
        .every((method) => method === 'GET'),
    ).toBe(true);
    identityStatus = 'enabled';
    await request(guarded.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', first)
      .expect(401);
  });
});

it('fails closed on unconfirmed provider state, preserves sessions for retry and does not restore locally disabled access', async () => {
  await withIdentityStatusApp(async (guarded) => {
    const cookie = cookies(await statusLogin(guarded), SESSION_COOKIE);
    for (const state of [
      'outage',
      'token-outage',
      'missing',
      'malformed',
      'mismatched',
    ]) {
      identityStatus = state;
      if (state === 'token-outage')
        await request(guarded.getHttpServer())
          .get('/api/v1/health/ready')
          .expect(503);
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', cookie)
        .expect(503);
      expect(await store.readSession(handle(cookie))).toBeDefined();
      await request(guarded.getHttpServer())
        .get(`/api/v1/tenants/${tenantId}/employees`)
        .set('Cookie', cookie)
        .expect(503);
    }
    identityStatus = 'enabled';
    await request(guarded.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    await admin.identity.update({
      where: { id: identityId },
      data: { status: 'disabled' },
    });
    await request(guarded.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .expect(401);
    await statusLogin(guarded, 401);
    expect(
      (await admin.identity.findUniqueOrThrow({ where: { id: identityId } }))
        .status,
    ).toBe('disabled');
  });
});

it('keeps provider enabled and other-company access when only one company membership is revoked', async () => {
  await withIdentityStatusApp(async (guarded) => {
    const otherTenantId = randomUUID();
    try {
      await admin.tenant.create({
        data: {
          id: otherTenantId,
          name: 'Synthetic second company',
          employeeLimit: 5,
        },
      });
      await admin.membership.create({
        data: { tenantId: otherTenantId, identityId, roles: ['owner'] },
      });
      const cookie = cookies(await statusLogin(guarded), SESSION_COOKIE);
      await admin.membership.updateMany({
        where: { tenantId, identityId },
        data: { status: 'revoked' },
      });
      const result = await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', cookie)
        .expect(200);
      expect(
        result.body.tenants.map((tenant: { id: string }) => tenant.id),
      ).toEqual([otherTenantId]);
      expect(
        (await admin.identity.findUniqueOrThrow({ where: { id: identityId } }))
          .status,
      ).toBe('active');
      expect(identityStatus).toBe('enabled');
    } finally {
      await admin.membership.deleteMany({ where: { tenantId: otherTenantId } });
      await admin.tenant.deleteMany({ where: { id: otherTenantId } });
    }
  });
});

async function withDurableLogoutApp(
  work: (guarded: INestApplication) => Promise<void>,
) {
  const previous = process.env.AUTH_LOGOUT_MODE;
  let guarded: INestApplication | undefined;
  try {
    vi.stubEnv('AUTH_LOGOUT_MODE', 'durable');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    guarded = module.createNestApplication();
    configureHttp(guarded);
    await guarded.init();
    await work(guarded);
  } finally {
    await guarded?.close();
    vi.stubEnv('AUTH_LOGOUT_MODE', previous);
  }
}
const logoutNamespace = () => digest(`${issuer}|${clientId}|${origin}`);
const sendLogout = (guarded: INestApplication, token: string) =>
  request(guarded.getHttpServer())
    .post('/api/v1/auth/backchannel-logout')
    .type('form')
    .send({ logout_token: token });
it('persists verified logout across Redis failure and API restart without granting a revoked session', async () => {
  let cookie = '';
  const jti = randomUUID();
  const failure = vi
    .spyOn(AuthStore.prototype, 'applyProviderLogout')
    .mockRejectedValue(new Error('synthetic Redis outage'));
  try {
    await withDurableLogoutApp(async (guarded) => {
      cookie = cookies(await statusLogin(guarded), SESSION_COOKIE);
      await sendLogout(
        guarded,
        logoutToken({ jti, sid: providerSessionId }),
      ).expect(204);
      expect(await store.readSession(handle(cookie))).toBeDefined();
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', cookie)
        .expect(401);
      const event = await admin.authProviderLogoutEvent.findUniqueOrThrow({
        where: {
          namespace_eventKey: {
            namespace: logoutNamespace(),
            eventKey: digest(jti),
          },
        },
      });
      mode = 'recent-before-logout';
      await statusLogin(guarded, 401);
      mode = 'valid';
      expect(event.completedAt).toBeNull();
      await admin.authProviderLogoutEvent.update({
        where: {
          namespace_eventKey: {
            namespace: logoutNamespace(),
            eventKey: digest(jti),
          },
        },
        data: { acceptedAt: new Date(Date.now() - 600000) },
      });
      const { checkLogoutHealth } =
        await import('../../apps/api/src/auth/logout-health');
      const monitored = await checkLogoutHealth(() =>
        providerLogoutHealth(runtime, logoutNamespace()),
      );
      expect(monitored.backlog?.pending).toBe(1);
      expect(monitored.alerts).toContain('logout_backlog_overdue');
      expect(event.targetHash).toBe(digest(providerSessionId));
      expect(Object.keys(event).sort()).toEqual(
        [
          'namespace',
          'eventKey',
          'targetKind',
          'targetHash',
          'issuedAt',
          'acceptedAt',
          'completedAt',
          'lastAttemptedAt',
        ].sort(),
      );
    });
  } finally {
    failure.mockRestore();
  }
  await withDurableLogoutApp(async (restarted) => {
    const event = await admin.authProviderLogoutEvent.findUniqueOrThrow({
      where: {
        namespace_eventKey: {
          namespace: logoutNamespace(),
          eventKey: digest(jti),
        },
      },
    });
    expect(event.completedAt).not.toBeNull();
    expect(await store.readSession(handle(cookie))).toBeUndefined();
    await request(restarted.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .expect(401);
  });
});
it('keeps durable logout exact, session-scoped and safe to retry after completion failure', async () => {
  await withDurableLogoutApp(async (guarded) => {
    const first = cookies(await statusLogin(guarded), SESSION_COOKIE);
    providerSessionId = 'synthetic-other-provider-session';
    const other = cookies(await statusLogin(guarded), SESSION_COOKIE);
    const jti = randomUUID();
    const token = logoutToken({
      jti,
      sid: 'synthetic-provider-session',
      sub: subject,
    });
    const completeFailure = vi
      .spyOn(DatabaseService.prototype, 'completeProviderLogout')
      .mockRejectedValue(new Error('synthetic completion outage'));
    try {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => sendLogout(guarded, token)),
      );
      await guarded.get(AuthService).reconcileProviderLogouts();
      expect(responses.map((response) => response.status)).toEqual([
        204, 204, 204, 204,
      ]);
      expect(
        await admin.authProviderLogoutEvent.count({
          where: { namespace: logoutNamespace() },
        }),
      ).toBe(1);
      expect(await store.readSession(handle(first))).toBeUndefined();
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', other)
        .expect(200);
      await sendLogout(
        guarded,
        logoutToken({ jti, sid: providerSessionId }),
      ).expect(401);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      providerSessionId = 'synthetic-provider-session';
      const fresh = cookies(await statusLogin(guarded), SESSION_COOKIE);
      await sendLogout(guarded, token).expect(204);
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', fresh)
        .expect(200);
    } finally {
      completeFailure.mockRestore();
    }
    await guarded.get(AuthService).reconcileProviderLogouts();
    expect(await pendingProviderLogouts(runtime, logoutNamespace())).toEqual(
      [],
    );
  });
});
it('does not acknowledge an uncommitted logout and never queues forged tokens', async () => {
  await withDurableLogoutApp(async (guarded) => {
    const cookie = cookies(await statusLogin(guarded), SESSION_COOKIE);
    const acceptFailure = vi
      .spyOn(DatabaseService.prototype, 'acceptProviderLogout')
      .mockRejectedValue(new Error('synthetic PostgreSQL outage'));
    try {
      await sendLogout(guarded, logoutToken({ sid: providerSessionId })).expect(
        503,
      );
    } finally {
      acceptFailure.mockRestore();
    }
    await request(guarded.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    await sendLogout(
      guarded,
      logoutToken({ sid: providerSessionId, variant: 'signature' }),
    ).expect(401);
    expect(
      await admin.authProviderLogoutEvent.count({
        where: { namespace: logoutNamespace() },
      }),
    ).toBe(0);
    const readFailure = vi
      .spyOn(DatabaseService.prototype, 'providerSessionRevoked')
      .mockRejectedValue(new Error('synthetic revocation lookup outage'));
    try {
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', cookie)
        .expect(503);
    } finally {
      readFailure.mockRestore();
    }
  });
});
it('keeps provider logout metadata private and pending batches bounded to one namespace', async () => {
  const namespace = digest(randomUUID());
  const otherNamespace = digest(randomUUID());
  try {
    await admin.authProviderLogoutEvent.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        namespace,
        eventKey: digest(String(index)),
        targetKind: 'subject',
        targetHash: digest(`${issuer}\0${subject}`),
        issuedAt: 1n,
      })),
    });
    const firstBatch = await pendingProviderLogouts(runtime, namespace);
    const secondBatch = await pendingProviderLogouts(runtime, namespace);
    expect(firstBatch).toHaveLength(25);
    expect(secondBatch).toHaveLength(25);
    expect(
      new Set([...firstBatch, ...secondBatch].map((event) => event.eventKey))
        .size,
    ).toBe(30);
    expect(await pendingProviderLogouts(runtime, otherNamespace)).toEqual([]);
    expect(
      await providerSessionRevoked(
        runtime,
        namespace,
        digest(`${issuer}\0${subject}`),
        undefined,
        0,
      ),
    ).toBe(true);
    expect(
      await providerSessionRevoked(
        runtime,
        otherNamespace,
        digest(`${issuer}\0${subject}`),
        undefined,
        0,
      ),
    ).toBe(false);
    await expect(runtime.authProviderLogoutEvent.findMany()).rejects.toThrow(
      /permission denied/,
    );
    const functions = await admin.$queryRaw<
      { safe: boolean }[]
    >`SELECT p.prosecdef AND r.rolname='kinto_control_owner' AND p.proconfig=ARRAY['search_path=pg_catalog, public'] AND NOT has_function_privilege('kinto_worker',p.oid,'EXECUTE') AND NOT has_function_privilege('kinto_dispatcher',p.oid,'EXECUTE') AS safe FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname IN ('accept_provider_logout','pending_provider_logouts','provider_logout_health','complete_provider_logout','provider_session_revoked')`;
    expect(functions).toHaveLength(5);
    expect(functions.every((row) => row.safe)).toBe(true);
  } finally {
    await admin.authProviderLogoutEvent.deleteMany({ where: { namespace } });
  }
});

it('leaves malformed or oversized Redis logout targets pending without partial session deletion', async () => {
  await withDurableLogoutApp(async (guarded) => {
    const first = cookies(await statusLogin(guarded), SESSION_COOKIE);
    const second = cookies(await statusLogin(guarded), SESSION_COOKIE);
    const key = store.key('session', handle(second));
    const original = await store.redis.get(key);
    expect(original).toBeTruthy();
    const jti = randomUUID();
    const index = `kinto:auth:v2:${logoutNamespace()}:provider-session:${digest(providerSessionId)}`;
    const stale = Array.from({ length: 1001 }, () =>
      store.key('session', opaqueToken()),
    );
    try {
      await store.redis.set(key, 'invalid synthetic JSON');
      await sendLogout(
        guarded,
        logoutToken({ jti, sid: providerSessionId }),
      ).expect(204);
      await guarded.get(AuthService).reconcileProviderLogouts();
      expect(await store.readSession(handle(first))).toBeDefined();
      await request(guarded.getHttpServer())
        .get('/api/v1/auth/session')
        .set('Cookie', first)
        .expect(401);
      await store.redis.set(key, original!, 'EX', IDLE_SECONDS);
      await store.redis.sadd(index, ...stale);
      await guarded.get(AuthService).reconcileProviderLogouts();
      expect(await store.readSession(handle(first))).toBeDefined();
      expect(
        (
          await admin.authProviderLogoutEvent.findUniqueOrThrow({
            where: {
              namespace_eventKey: {
                namespace: logoutNamespace(),
                eventKey: digest(jti),
              },
            },
          })
        ).completedAt,
      ).toBeNull();
    } finally {
      await store.redis.srem(index, ...stale);
      if (await store.redis.exists(key))
        await store.redis.set(key, original!, 'EX', IDLE_SECONDS);
    }
    await guarded.get(AuthService).reconcileProviderLogouts();
    expect(await store.readSession(handle(first))).toBeUndefined();
    expect(await store.readSession(handle(second))).toBeUndefined();
  });
});

it('monitors only namespace aggregates without claiming receipts and signals failed cleanup', async () => {
  const namespace = digest(randomUUID());
  const other = digest(randomUUID());
  try {
    const now = Date.now();
    await admin.authProviderLogoutEvent.createMany({
      data: [
        {
          namespace,
          eventKey: digest('pending-monitor'),
          targetKind: 'subject',
          targetHash: digest('private-subject'),
          issuedAt: 1n,
          acceptedAt: new Date(now - 600000),
        },
        {
          namespace,
          eventKey: digest('attempted-monitor'),
          targetKind: 'session',
          targetHash: digest('private-sid'),
          issuedAt: 1n,
          acceptedAt: new Date(now - 400000),
          lastAttemptedAt: new Date(now - 60000),
        },
        {
          namespace,
          eventKey: digest('completed-monitor'),
          targetKind: 'subject',
          targetHash: digest('completed'),
          issuedAt: 1n,
          acceptedAt: new Date(now - 900000),
          completedAt: new Date(now),
        },
        {
          namespace: other,
          eventKey: digest('other-monitor'),
          targetKind: 'subject',
          targetHash: digest('other'),
          issuedAt: 1n,
          acceptedAt: new Date(now - 900000),
        },
      ],
    });
    const before = await admin.authProviderLogoutEvent.findMany({
      where: { namespace },
      orderBy: { eventKey: 'asc' },
    });
    const snapshot = await providerLogoutHealth(runtime, namespace);
    expect(snapshot.pending).toBe(2);
    expect(snapshot.unattempted).toBe(1);
    expect(snapshot.oldestPendingSeconds).toBeGreaterThanOrEqual(600);
    expect(snapshot.oldestPendingSeconds).toBeLessThan(620);
    expect(snapshot.lastAttemptSeconds).toBeGreaterThanOrEqual(60);
    const { checkLogoutHealth } =
      await import('../../apps/api/src/auth/logout-health');
    expect(
      (await checkLogoutHealth(() => providerLogoutHealth(runtime, namespace)))
        .alerts,
    ).toEqual(['logout_backlog_overdue', 'logout_reconciliation_stalled']);
    expect(
      await admin.authProviderLogoutEvent.findMany({
        where: { namespace },
        orderBy: { eventKey: 'asc' },
      }),
    ).toEqual(before);
    expect(
      await providerLogoutHealth(runtime, digest('empty-monitor')),
    ).toEqual({
      pending: 0,
      unattempted: 0,
      oldestPendingSeconds: 0,
      lastAttemptSeconds: null,
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      'lastAttemptSeconds',
      'oldestPendingSeconds',
      'pending',
      'unattempted',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(namespace);
    await expect(providerLogoutHealth(runtime, 'bad')).rejects.toThrow(
      'Invalid provider logout digest',
    );
    await admin.authProviderLogoutEvent.updateMany({
      where: { namespace, completedAt: null },
      data: { lastAttemptedAt: new Date() },
    });
    expect(
      (await checkLogoutHealth(() => providerLogoutHealth(runtime, namespace)))
        .alerts,
    ).toEqual(['logout_backlog_overdue']);
    await admin.authProviderLogoutEvent.updateMany({
      where: { namespace },
      data: { completedAt: new Date() },
    });
    expect(
      (await checkLogoutHealth(() => providerLogoutHealth(runtime, namespace)))
        .status,
    ).toBe('ready');
  } finally {
    await admin.authProviderLogoutEvent.deleteMany({
      where: { namespace: { in: [namespace, other] } },
    });
  }
});

it('runs the private logout health command with bounded exit codes and redacted diagnostics', async () => {
  const namespace = logoutNamespace();
  const probe = async (changes: NodeJS.ProcessEnv = {}) => {
    let output: string;
    let code = 0;
    try {
      output = (
        await promisify(execFile)(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', 'scripts/check-provider-logout.ts'],
          {
            env: {
              ...process.env,
              AUTH_LOGOUT_MODE: 'durable',
              AUTH_LOGOUT_MAX_PENDING_SECONDS: '300',
              AUTH_LOGOUT_MAX_IDLE_SECONDS: '30',
              ...changes,
            },
            timeout: 10000,
          },
        )
      ).stdout;
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      expect(failure.stderr).toBe('');
      expect(failure.code).toBe(1);
      code = failure.code;
      output = failure.stdout;
    }
    return {
      code,
      report: JSON.parse(output.trim()) as {
        status: string;
        alerts: string[];
        backlog: unknown;
      },
    };
  };
  expect(await probe()).toEqual({
    code: 0,
    report: {
      status: 'ready',
      alerts: [],
      backlog: {
        pending: 0,
        unattempted: 0,
        oldestPendingSeconds: 0,
        lastAttemptSeconds: null,
      },
    },
  });
  await admin.authProviderLogoutEvent.create({
    data: {
      namespace,
      eventKey: digest('cli-monitor'),
      targetKind: 'subject',
      targetHash: digest('private-cli'),
      issuedAt: 1n,
      acceptedAt: new Date(Date.now() - 600000),
    },
  });
  const overdue = await probe();
  expect(overdue.code).toBe(1);
  expect(overdue.report.alerts).toEqual([
    'logout_backlog_overdue',
    'logout_reconciliation_stalled',
  ]);
  expect(JSON.stringify(overdue.report)).not.toContain(namespace);
  expect(
    (await probe({ AUTH_LOGOUT_MODE: 'synchronous' })).report.alerts,
  ).toEqual(['logout_durable_mode_required']);
  expect(
    (await probe({ AUTH_LOGOUT_MAX_PENDING_SECONDS: '0' })).report.alerts,
  ).toEqual(['logout_monitor_configuration_invalid']);
  const failed = await probe({
    DATABASE_URL:
      'postgresql://private:secret@127.0.0.1:1/kinto_test?connect_timeout=1',
  });
  expect(failed.report).toEqual({
    status: 'unavailable',
    alerts: ['logout_probe_unavailable'],
    backlog: null,
  });
});
