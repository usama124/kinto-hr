import { expect, it, vi } from 'vitest';
import {
  KeycloakIdentityStatus,
  readIdentityStatusConfig,
} from './identity-status';
const env = {
  IDENTITY_STATUS_MODE: 'keycloak',
  AUTH_MODE: 'oidc',
  OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
  OIDC_ISSUER: 'https://identity.example/realms/kinto',
  AUTH_ORIGIN: 'https://hr.example',
  OIDC_CLIENT_ID: 'kinto-web',
  KEYCLOAK_IDENTITY_STATUS_CLIENT_ID: 'status-reader',
  KEYCLOAK_IDENTITY_STATUS_CLIENT_SECRET: 'synthetic-status-secret',
};
const principal = { issuer: env.OIDC_ISSUER, subject: 'synthetic-subject' };
const token = () =>
  Response.json({
    access_token: 'synthetic-read-only-token',
    token_type: 'Bearer',
    expires_in: 60,
  });
it('keeps checks disabled by default and requires separate trusted read-only configuration', () => {
  expect(readIdentityStatusConfig({})).toBeUndefined();
  expect(readIdentityStatusConfig(env)?.managementClientId).toBe(
    'status-reader',
  );
  for (const override of [
    { IDENTITY_STATUS_MODE: 'enabled' },
    { AUTH_MODE: 'disabled' },
    { OIDC_MFA_PROFILE: 'none' },
    { KEYCLOAK_IDENTITY_STATUS_CLIENT_SECRET: 'short' },
    { OIDC_ISSUER: 'http://identity.example/realms/kinto' },
    { OIDC_ISSUER: 'https://identity.example/not-a-realm' },
  ])
    expect(() => readIdentityStatusConfig({ ...env, ...override })).toThrow();
});
it.each([true, false])(
  'reads exact provider enabled=%s using only token POST and user GET',
  async (enabled) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        Response.json({
          ...principal,
          id: principal.subject,
          enabled,
          email: 'private@example.test',
        }),
      );
    const reader = new KeycloakIdentityStatus(
      readIdentityStatusConfig(env)!,
      fetcher,
    );
    expect(await reader.enabled(principal)).toBe(enabled);
    expect(
      fetcher.mock.calls.map(([url, init]) => [String(url), init?.method]),
    ).toEqual([
      [
        'https://identity.example/realms/kinto/protocol/openid-connect/token',
        'POST',
      ],
      [
        'https://identity.example/admin/realms/kinto/users/synthetic-subject',
        'GET',
      ],
    ]);
    expect(
      fetcher.mock.calls.every(
        ([, init]) =>
          init?.redirect === 'error' && init.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  },
);
it.each([
  () => Response.json({ id: 'different-subject', enabled: false }),
  () => Response.json({ id: principal.subject, enabled: 'false' }),
  () => Response.json({ id: principal.subject }),
  () => new Response('', { status: 404 }),
  () => new Response('', { status: 403 }),
  () => new Response('', { status: 503 }),
])(
  'rejects unconfirmed provider state without treating it as disabled',
  async (response) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(response());
    await expect(
      new KeycloakIdentityStatus(
        readIdentityStatusConfig(env)!,
        fetcher,
      ).enabled(principal),
    ).rejects.toThrow();
  },
);
it('rejects realm mismatch before sending credentials, and safely fails token outages', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('unavailable'));
  const reader = new KeycloakIdentityStatus(
    readIdentityStatusConfig(env)!,
    fetcher,
  );
  await expect(
    reader.enabled({
      ...principal,
      issuer: 'https://other.example/realms/kinto',
    }),
  ).rejects.toThrow('binding mismatch');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(reader.enabled(principal)).rejects.toThrow();
});
