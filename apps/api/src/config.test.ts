import { expect, it } from 'vitest';
import { readConfig } from './config';
import { readAuthConfig } from './auth/config';
it('requires an explicit PostgreSQL runtime URL', () => {
  expect(() => readConfig({})).toThrow();
  expect(() => readConfig({ DATABASE_URL: 'https://example.com' })).toThrow();
  expect(
    readConfig({ DATABASE_URL: 'postgresql://localhost/kinto_test' }),
  ).toEqual({
    databaseUrl: 'postgresql://localhost/kinto_test',
    port: 4000,
    host: '127.0.0.1',
  });
});

const authEnv = {
  AUTH_MODE: 'oidc',
  NODE_ENV: 'production',
  OIDC_ISSUER: 'https://identity.example/realms/kinto',
  AUTH_ORIGIN: 'https://hr.example',
  OIDC_CLIENT_ID: 'kinto',
  OIDC_CLIENT_SECRET: 'synthetic-client-secret',
  AUTH_REDIS_URL: 'rediss://redis.example/0',
};
it('keeps authentication disabled unless explicitly configured', () => {
  expect(readAuthConfig({})).toBeUndefined();
  expect(() => readAuthConfig({ AUTH_MODE: 'true' })).toThrow();
  expect(() => readAuthConfig({ AUTH_MODE: 'oidc' })).toThrow();
  expect(readAuthConfig(authEnv)?.origin).toBe('https://hr.example');
  expect(readAuthConfig(authEnv)?.mfaProfile).toBe('none');
  expect(
    readAuthConfig({ ...authEnv, OIDC_MFA_PROFILE: 'keycloak-loa2-v1' })
      ?.mfaProfile,
  ).toBe('keycloak-loa2-v1');
  expect(() =>
    readAuthConfig({ ...authEnv, OIDC_MFA_PROFILE: 'trust-any-amr' }),
  ).toThrow();
});
it.each([
  { OIDC_ISSUER: 'http://identity.example/realm' },
  { OIDC_ISSUER: 'https://user:secret@identity.example/realm' },
  { OIDC_ISSUER: 'https://identity.example/realm?untrusted=yes' },
  { AUTH_ORIGIN: 'https://hr.example/path' },
  { AUTH_ORIGIN: 'http://localhost:3000' },
  { OIDC_CLIENT_SECRET: 'short' },
  { AUTH_REDIS_URL: 'redis://127.0.0.1:6379' },
])('rejects unsafe auth settings %j', (override) => {
  expect(() => readAuthConfig({ ...authEnv, ...override })).toThrow();
});
it('permits plain HTTP/Redis only on loopback in explicit local modes', () => {
  const env = {
    ...authEnv,
    NODE_ENV: 'development',
    OIDC_ISSUER: 'http://127.0.0.1:8080/realm',
    AUTH_ORIGIN: 'http://localhost:3000',
    AUTH_REDIS_URL: 'redis://127.0.0.1:6379',
  };
  expect(readAuthConfig(env)?.local).toBe(true);
  expect(() =>
    readAuthConfig({ ...env, OIDC_ISSUER: 'http://remote.example' }),
  ).toThrow();
  expect(() =>
    readAuthConfig({ ...env, AUTH_REDIS_URL: 'redis://remote.example' }),
  ).toThrow();
  expect(() => readAuthConfig({ ...env, NODE_ENV: undefined })).toThrow();
});
it('validates port and listen host', () => {
  expect(
    readConfig({
      DATABASE_URL: 'postgres://localhost/kinto_test',
      API_PORT: '4010',
      API_HOST: '0.0.0.0',
    }).port,
  ).toBe(4010);
  expect(() =>
    readConfig({
      DATABASE_URL: 'postgres://localhost/kinto_test',
      API_PORT: '0',
    }),
  ).toThrow();
  expect(() =>
    readConfig({
      DATABASE_URL: 'postgres://localhost/kinto_test',
      API_HOST: 'untrusted',
    }),
  ).toThrow();
});
