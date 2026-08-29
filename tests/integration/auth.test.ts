import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createDatabase, inAuthorizedTenant } from '@kinto/database';
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
let tokenRequests = 0;
let mode = 'valid';
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
    if (url.pathname === '/.well-known/openid-configuration') {
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
    if (url.pathname === '/jwks')
      return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === '/authorize') {
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
    if (url.pathname === '/token') {
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
  issuer = `http://127.0.0.1:${address.port}`;
  for (const [key, value] of Object.entries({
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
  await admin.tenant.create({
    data: { id: tenantId, name: 'Synthetic auth company', employeeLimit: 5 },
  });
  await admin.membership.create({
    data: { tenantId, identityId, roles: ['owner'] },
  });
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  configureHttp(app);
  await app.init();
});
beforeEach(async () => {
  mode = 'valid';
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
  if (store) {
    // Only fixture-specific keys; never FLUSHDB or shared application cleanup.
    const keys = await store.redis.keys(
      `kinto:auth:v2:${digest(`${issuer}|${clientId}|${origin}`)}:*`,
    );
    if (keys.length) await store.redis.del(...keys);
    store.close();
  }
  await admin.membership.deleteMany({ where: { tenantId } });
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
  ]);
  expect(response.body.identityId).toBe(identityId);
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
it('keeps registration, provisioning and employee endpoints closed even when login is enabled', async () => {
  const result = await login();
  for (const path of [
    '/api/v1/auth/signup',
    '/api/v1/auth/register',
    '/api/v1/platform/tenants',
    `/api/v1/tenants/${tenantId}/employees`,
  ])
    await request(app.getHttpServer())
      .post(path)
      .set('Cookie', result.sessionCookie)
      .send({ role: 'owner' })
      .expect(404);
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
