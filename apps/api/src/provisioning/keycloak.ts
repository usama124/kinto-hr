import { z } from 'zod';
import { type ProvisioningConfig, OWNER_INVITATION_SECONDS } from './config';

const marker = 'kinto_provisioning_request';
const tokenSchema = z.object({
  access_token: z.string().min(16).max(16384),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});
const userSchema = z.object({
  id: z.string().min(1).max(255),
  email: z.email().transform((value) => value.toLowerCase()),
  emailVerified: z.boolean(),
  enabled: z.boolean(),
  attributes: z.record(z.string(), z.array(z.string())).optional(),
});
type ProviderUser = z.infer<typeof userSchema>;

export class KeycloakProvisioner {
  constructor(
    private readonly config: ProvisioningConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async call(url: string | URL, init: RequestInit) {
    const target = new URL(url);
    const expected = new URL(this.config.issuer);
    if (
      target.origin !== expected.origin ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error('Unexpected Keycloak management endpoint');
    return this.request(target, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  }

  private async token() {
    const basic = Buffer.from(
      `${this.config.managementClientId}:${this.config.managementClientSecret}`,
    ).toString('base64');
    const response = await this.call(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (!response.ok)
      throw new Error('Keycloak management authentication failed');
    return tokenSchema.parse(await response.json()).access_token;
  }

  private async admin(path: string, init: RequestInit, token: string) {
    if (!path.startsWith('/')) throw new Error('Invalid admin path');
    return this.call(`${this.config.adminBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  }

  private markers(user: ProviderUser) {
    return user.attributes?.[marker] ?? [];
  }

  private async exactUser(email: string, token: string) {
    const query = new URLSearchParams({ email, exact: 'true', max: '2' });
    const response = await this.admin(
      `/users?${query}`,
      { method: 'GET' },
      token,
    );
    if (!response.ok) throw new Error('Keycloak user reconciliation failed');
    const users = z
      .array(userSchema)
      .max(2)
      .parse(await response.json());
    const exact = users.filter((user) => user.email === email);
    if (exact.length !== 1) throw new Error('Keycloak identity is ambiguous');
    return exact[0];
  }

  async reconcileUser(requestId: string, email: string) {
    const token = await this.token();
    const response = await this.admin(
      '/users',
      {
        method: 'POST',
        body: JSON.stringify({
          username: email,
          email,
          enabled: false,
          emailVerified: false,
          attributes: { [marker]: [requestId] },
        }),
      },
      token,
    );
    let user: ProviderUser;
    let created = false;
    if (response.status === 201) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Keycloak user identifier missing');
      const target = new URL(location, this.config.adminBaseUrl);
      const prefix = `${this.config.adminBaseUrl}/users/`;
      const encodedSubject = target.href.startsWith(prefix)
        ? target.href.slice(prefix.length)
        : '';
      if (
        !encodedSubject ||
        encodedSubject.includes('/') ||
        target.search ||
        target.hash
      )
        throw new Error('Unexpected Keycloak user location');
      user = {
        id: decodeURIComponent(encodedSubject),
        email,
        emailVerified: false,
        enabled: false,
        attributes: { [marker]: [requestId] },
      };
      user = userSchema.parse(user);
      created = true;
    } else if (response.status === 409) {
      user = await this.exactUser(email, token);
    } else {
      throw new Error('Keycloak user creation failed');
    }

    const markers = this.markers(user);
    if (!created && user.enabled && !user.emailVerified)
      throw new Error('Unverified Keycloak identity cannot be claimed');
    if (!user.enabled && !created && !markers.includes(requestId))
      throw new Error('Disabled Keycloak identity cannot be claimed');
    if (!markers.includes(requestId)) {
      const update = await this.admin(
        `/users/${encodeURIComponent(user.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            attributes: {
              ...user.attributes,
              [marker]: [...markers, requestId],
            },
          }),
        },
        token,
      );
      if (update.status !== 204)
        throw new Error('Keycloak reconciliation marker failed');
    }
    return { subject: user.id, enableRequired: !user.enabled };
  }

  async deliverActions(subject: string) {
    const token = await this.token();
    const enabled = await this.admin(
      `/users/${encodeURIComponent(subject)}`,
      { method: 'PUT', body: JSON.stringify({ enabled: true }) },
      token,
    );
    if (enabled.status !== 204) throw new Error('Keycloak user enable failed');
    const redirect = `${this.config.origin}/api/v1/auth/login`;
    const query = new URLSearchParams({
      client_id: this.config.loginClientId,
      redirect_uri: redirect,
      lifespan: String(OWNER_INVITATION_SECONDS),
    });
    const delivered = await this.admin(
      `/users/${encodeURIComponent(subject)}/execute-actions-email?${query}`,
      {
        method: 'PUT',
        body: JSON.stringify([
          'VERIFY_EMAIL',
          'UPDATE_PASSWORD',
          'CONFIGURE_TOTP',
        ]),
      },
      token,
    );
    if (delivered.status !== 204)
      throw new Error('Keycloak activation delivery failed');
  }
}
