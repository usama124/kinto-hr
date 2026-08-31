import { afterEach, expect, it, vi } from 'vitest';
import { OwnerProvisioningService } from './service';
import { type DatabaseService } from '../database.service';

const requestId = '70c337f0-3072-4b78-b0f6-abecf2162135';
const invitationId = '2398a535-94dc-4fc1-8e82-e28b61fef8b4';
const subject = '4c842628-8c4a-43c2-842b-44fba9439773';
function configure() {
  for (const [key, value] of Object.entries({
    ACCOUNT_PROVISIONING_MODE: 'keycloak',
    AUTH_MODE: 'oidc',
    OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
    OIDC_ISSUER: 'https://identity.example/realms/kinto',
    AUTH_ORIGIN: 'https://hr.example',
    OIDC_CLIENT_ID: 'kinto-web',
    KEYCLOAK_PROVISIONING_CLIENT_ID: 'kinto-provisioner',
    KEYCLOAK_PROVISIONING_CLIENT_SECRET: 'synthetic-management-secret',
  }))
    vi.stubEnv(key, value);
}
const token = () =>
  new Response(
    JSON.stringify({
      access_token: 'synthetic-access-token',
      token_type: 'Bearer',
      expires_in: 60,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('persists provider identity before email and marks delivery only afterward', async () => {
  configure();
  const reconcileCompanyOwner = vi.fn().mockResolvedValue({
    invitationId,
    status: 'pending_delivery',
    expiresAt: new Date(Date.now() + 1000),
    replayed: false,
  });
  const markOwnerInvitationDelivered = vi
    .fn()
    .mockResolvedValue({ status: 'pending_activation', replayed: false });
  const database = {
    reconcileCompanyOwner,
    markOwnerInvitationDelivered,
  } as unknown as DatabaseService;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: {
          Location: `https://identity.example/admin/realms/kinto/users/${subject}`,
        },
      }),
    )
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    new OwnerProvisioningService(database).attempt(
      requestId,
      'owner@example.com',
    ),
  ).resolves.toEqual({ status: 'pending_activation' });
  expect(reconcileCompanyOwner).toHaveBeenCalledWith(
    requestId,
    {
      issuer: 'https://identity.example/realms/kinto',
      subject,
    },
    expect.any(Date),
  );
  expect(markOwnerInvitationDelivered).toHaveBeenCalledAfter(
    reconcileCompanyOwner,
  );
});

it('uses the same provider boundary for a fixed employee invitation', async () => {
  configure();
  const reconcileEmployeeAccount = vi.fn().mockResolvedValue({
    invitationId,
    status: 'pending_delivery',
    expiresAt: new Date(Date.now() + 1000),
    replayed: false,
  });
  const markEmployeeInvitationDelivered = vi
    .fn()
    .mockResolvedValue({ status: 'pending_activation', replayed: false });
  const database = {
    reconcileEmployeeAccount,
    markEmployeeInvitationDelivered,
  } as unknown as DatabaseService;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(
      new Response(null, {
        status: 201,
        headers: {
          Location: `https://identity.example/admin/realms/kinto/users/${subject}`,
        },
      }),
    )
    .mockResolvedValueOnce(token())
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    new OwnerProvisioningService(database).attemptEmployee(
      requestId,
      'employee@example.com',
    ),
  ).resolves.toEqual({ status: 'pending_activation' });
  expect(reconcileEmployeeAccount).toHaveBeenCalledWith(
    requestId,
    {
      issuer: 'https://identity.example/realms/kinto',
      subject,
    },
    expect.any(Date),
  );
  expect(markEmployeeInvitationDelivered).toHaveBeenCalledAfter(
    reconcileEmployeeAccount,
  );
});

it('keeps partial provider or persistence failures pending and retryable', async () => {
  configure();
  const database = {
    reconcileCompanyOwner: vi.fn(),
    markOwnerInvitationDelivered: vi.fn(),
  } as unknown as DatabaseService;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('private secret')),
  );
  await expect(
    new OwnerProvisioningService(database).attempt(
      requestId,
      'owner@example.com',
    ),
  ).resolves.toEqual({ status: 'pending_identity_provider' });
  expect(database.reconcileCompanyOwner).not.toHaveBeenCalled();
  expect(database.markOwnerInvitationDelivered).not.toHaveBeenCalled();
});

it('does not resend an unexpired activation or run while disabled', async () => {
  configure();
  const database = {
    reconcileCompanyOwner: vi.fn().mockResolvedValue({
      invitationId,
      status: 'pending_activation',
      expiresAt: new Date(Date.now() + 60_000),
      replayed: true,
    }),
    markOwnerInvitationDelivered: vi.fn(),
  } as unknown as DatabaseService;
  const fetcher = vi
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
            attributes: { kinto_provisioning_request: [requestId] },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    new OwnerProvisioningService(database).attempt(
      requestId,
      'owner@example.com',
    ),
  ).resolves.toEqual({ status: 'pending_activation' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(database.markOwnerInvitationDelivered).not.toHaveBeenCalled();

  vi.unstubAllEnvs();
  expect(
    await new OwnerProvisioningService(database).attempt(
      requestId,
      'owner@example.com',
    ),
  ).toBeUndefined();
});
