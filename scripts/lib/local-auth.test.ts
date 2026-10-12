import { describe, expect, it } from 'vitest';
import { parseEnv } from 'node:util';
import { assertLocalAuthTarget, updateLocalEnv } from './local-auth';
import { loopbackRealm } from '../../infra/keycloak/loopback-realm';
import { testRealm } from '../../infra/keycloak/test-realm';

const env = {
  MIGRATION_DATABASE_URL:
    'postgresql://admin:password@127.0.0.1:55432/kinto_test',
  DATABASE_URL: 'postgresql://kinto_app:password@127.0.0.1:55432/kinto_test',
  REDIS_URL: 'redis://127.0.0.1:56379/0',
};
const input = {
  realm: `kinto_local_${'a'.repeat(32)}`,
  origin: 'https://localhost:3443',
  smtpPort: 1025,
  backchannelUrl: 'http://127.0.0.1:4000/api/v1/auth/backchannel-logout',
  clientSecret: 'local-web-secret',
  provisioningClientSecret: 'local-provisioner-secret',
  users: [
    {
      id: 'local-subject',
      username: 'platform-admin',
      password: 'local-password',
      requiredActions: ['CONFIGURE_TOTP'],
    },
  ],
};
describe('persistent local authentication boundaries', () => {
  it('accepts dedicated local test database and restricted runtime role', () => {
    expect(() => assertLocalAuthTarget(env)).not.toThrow();
  });
  it.each([
    { NODE_ENV: 'production' },
    {
      MIGRATION_DATABASE_URL:
        'postgresql://admin:password@db.example/kinto_test',
    },
    {
      MIGRATION_DATABASE_URL:
        'postgresql://admin:password@127.0.0.1:55432/customer_hr',
    },
    { DATABASE_URL: env.MIGRATION_DATABASE_URL },
    { REDIS_URL: 'redis://remote.example/0' },
    { REDIS_URL: 'redis://127.0.0.1:56379/1' },
    { API_PORT: '4100' },
    { API_HOST: '0.0.0.0' },
  ])('refuses unsafe targets %o', (override) => {
    expect(() => assertLocalAuthTarget({ ...env, ...override })).toThrow();
  });
  it('preserves unrelated settings and removes duplicate changed assignments', () => {
    const updated = updateLocalEnv(
      '# Keep\nDATABASE_URL="original"\nAUTH_MODE=disabled\nexport AUTH_MODE=disabled\n',
      { AUTH_MODE: 'oidc', OIDC_CLIENT_SECRET: 'random$literal`secret' },
    );
    expect(parseEnv(updated)).toEqual({
      DATABASE_URL: 'original',
      AUTH_MODE: 'oidc',
      OIDC_CLIENT_SECRET: 'random$literal`secret',
    });
    expect(updated).toContain('# Keep');
    expect(updated.match(/^AUTH_MODE=/gm)).toHaveLength(1);
  });
  it('rejects newline and quoting injection in generated assignments', () => {
    expect(() =>
      updateLocalEnv('', { AUTH_MODE: 'oidc\nOTHER=value' }),
    ).toThrow();
    expect(() => updateLocalEnv('', { AUTH_MODE: "oidc'" })).toThrow();
  });
  it('retains mandatory OTP, closed registration and exact redirects', () => {
    const realm = loopbackRealm(input);
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.actionTokenGeneratedByUserLifespan).toBe(900);
    expect(realm.users[0]).toEqual(
      expect.objectContaining({ requiredActions: ['CONFIGURE_TOTP'] }),
    );
    const web = realm.clients.find(
      (client) => client.clientId === 'kinto-web',
    )!;
    expect(web.directAccessGrantsEnabled).toBe(false);
    expect(web.implicitFlowEnabled).toBe(false);
    expect(web.redirectUris).toEqual([
      `${input.origin}/api/v1/auth/callback`,
      `${input.origin}/api/v1/auth/login`,
    ]);
    const otp = realm.authenticationFlows.find(
      (flow) => flow.alias === 'kinto-level-2',
    )!;
    expect(otp.authenticationExecutions).toContainEqual(
      expect.objectContaining({
        authenticator: 'auth-otp-form',
        requirement: 'REQUIRED',
      }),
    );
    const provisioner = realm.users.find(
      (user) => user.username === 'service-account-kinto-provisioner',
    )!;
    expect(provisioner).toEqual(
      expect.objectContaining({
        clientRoles: {
          'realm-management': ['manage-users', 'query-users', 'view-users'],
        },
      }),
    );
  });
  it('keeps the disposable test wrapper restricted and rejects remote callbacks', () => {
    expect(
      testRealm({ ...input, realm: `kinto_test_${'a'.repeat(32)}` })
        .actionTokenGeneratedByUserLifespan,
    ).toBe(20);
    expect(() => testRealm(input)).toThrow();
    expect(() =>
      loopbackRealm({ ...input, origin: 'https://customer.example' }),
    ).toThrow();
    expect(() => loopbackRealm({ ...input, realm: 'production' })).toThrow();
  });
});
