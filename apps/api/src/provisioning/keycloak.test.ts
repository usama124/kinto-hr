import { expect, it, vi } from 'vitest';
import { KeycloakProvisioner } from './keycloak';
import { readProvisioningConfig } from './config';

const config = readProvisioningConfig({
  ACCOUNT_PROVISIONING_MODE: 'keycloak',
  AUTH_MODE: 'oidc',
  OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
  OIDC_ISSUER: 'https://identity.example/realms/kinto',
  AUTH_ORIGIN: 'https://hr.example',
  OIDC_CLIENT_ID: 'kinto-web',
  KEYCLOAK_PROVISIONING_CLIENT_ID: 'kinto-provisioner',
  KEYCLOAK_PROVISIONING_CLIENT_SECRET: 'synthetic-management-secret',
})!;
const requestId = '70c337f0-3072-4b78-b0f6-abecf2162135';
const subject = '4c842628-8c4a-43c2-842b-44fba9439773';
const token = () =>
  new Response(
    JSON.stringify({
      access_token: 'synthetic-access-token',
      token_type: 'Bearer',
      expires_in: 60,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

it('creates a disabled marked user, then enables it and sends bounded setup actions', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: {
          Location: `${config.adminBaseUrl}/users/${subject}`,
        },
      }),
    )
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const provider = new KeycloakProvisioner(config, mock);
  await expect(
    provider.reconcileUser(requestId, 'owner@example.com'),
  ).resolves.toEqual({ subject, enableRequired: true });
  await provider.deliverActions(subject);
  expect(mock).toHaveBeenCalledTimes(5);
  const create = mock.mock.calls[1];
  expect(JSON.parse(String(create[1]?.body))).toMatchObject({
    email: 'owner@example.com',
    enabled: false,
    attributes: { kinto_provisioning_request: [requestId] },
  });
  const deliveryUrl = new URL(String(mock.mock.calls[4][0]));
  expect(deliveryUrl.pathname).toBe(
    `/admin/realms/kinto/users/${subject}/execute-actions-email`,
  );
  expect(deliveryUrl.searchParams.get('lifespan')).toBe('172800');
  expect(deliveryUrl.searchParams.get('redirect_uri')).toBe(
    'https://hr.example/api/v1/auth/login',
  );
  expect(JSON.parse(String(mock.mock.calls[4][1]?.body))).toEqual([
    'VERIFY_EMAIL',
    'UPDATE_PASSWORD',
    'CONFIGURE_TOTP',
  ]);
});

it('reconciles one exact verified account without mutating provider attributes', async () => {
  const mock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: subject,
            email: 'owner@example.com',
            emailVerified: true,
            enabled: true,
            attributes: { existing: ['value'] },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  await expect(
    new KeycloakProvisioner(config, mock).reconcileUser(
      requestId,
      'owner@example.com',
    ),
  ).resolves.toEqual({ subject, enableRequired: false });
  expect(mock).toHaveBeenCalledTimes(3);
});

it('refuses ambiguous, disabled-unmarked, and untrusted provider identities', async () => {
  for (const userResponse of [
    [],
    [
      {
        id: subject,
        email: 'owner@example.com',
        emailVerified: false,
        enabled: false,
        attributes: {},
      },
    ],
    [
      {
        id: subject,
        email: 'owner@example.com',
        emailVerified: false,
        enabled: true,
        attributes: {},
      },
    ],
  ]) {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(userResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    await expect(
      new KeycloakProvisioner(config, mock).reconcileUser(
        requestId,
        'owner@example.com',
      ),
    ).rejects.toThrow();
  }
  const location = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: { Location: 'https://attacker.example/users/subject' },
      }),
    );
  await expect(
    new KeycloakProvisioner(config, location).reconcileUser(
      requestId,
      'owner@example.com',
    ),
  ).rejects.toThrow();
});
