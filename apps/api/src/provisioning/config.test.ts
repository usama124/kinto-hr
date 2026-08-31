import { expect, it } from 'vitest';
import { readProvisioningConfig } from './config';

const env = {
  ACCOUNT_PROVISIONING_MODE: 'keycloak',
  AUTH_MODE: 'oidc',
  OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
  OIDC_ISSUER: 'https://identity.example/realms/kinto',
  AUTH_ORIGIN: 'https://hr.example',
  OIDC_CLIENT_ID: 'kinto-web',
  KEYCLOAK_PROVISIONING_CLIENT_ID: 'kinto-provisioner',
  KEYCLOAK_PROVISIONING_CLIENT_SECRET: 'synthetic-management-secret',
};

it('keeps account provisioning disabled unless explicitly configured', () => {
  expect(readProvisioningConfig({})).toBeUndefined();
  expect(readProvisioningConfig(env)).toMatchObject({
    issuer: env.OIDC_ISSUER,
    origin: env.AUTH_ORIGIN,
    tokenUrl:
      'https://identity.example/realms/kinto/protocol/openid-connect/token',
    adminBaseUrl: 'https://identity.example/admin/realms/kinto',
  });
});

it.each([
  { ACCOUNT_PROVISIONING_MODE: 'enabled' },
  { AUTH_MODE: 'disabled' },
  { OIDC_MFA_PROFILE: 'none' },
  { OIDC_ISSUER: 'https://identity.example/not-a-realm' },
  { OIDC_ISSUER: 'http://identity.example/realms/kinto' },
  { KEYCLOAK_PROVISIONING_CLIENT_SECRET: 'short' },
])('rejects unsafe provisioning configuration %j', (override) => {
  expect(() => readProvisioningConfig({ ...env, ...override })).toThrow();
});

it('allows insecure endpoints only on loopback in explicit local modes', () => {
  expect(
    readProvisioningConfig({
      ...env,
      NODE_ENV: 'test',
      OIDC_ISSUER: 'http://127.0.0.1:8080/realms/kinto',
      AUTH_ORIGIN: 'http://localhost:3000',
    })?.adminBaseUrl,
  ).toBe('http://127.0.0.1:8080/admin/realms/kinto');
});
