import { z } from 'zod';
import {
  readProvisioningConfig,
  type ProvisioningConfig,
} from '../provisioning/config';

export function readIdentityStatusConfig(env: NodeJS.ProcessEnv) {
  const mode = z
    .enum(['disabled', 'keycloak'])
    .parse(env.IDENTITY_STATUS_MODE ?? 'disabled');
  if (mode === 'disabled') return undefined;
  // Reuse the reviewed realm/HTTPS/MFA boundary, with separate read-only
  // service-account credentials. Provisioning itself need not be enabled.
  return readProvisioningConfig({
    ...env,
    ACCOUNT_PROVISIONING_MODE: 'keycloak',
    KEYCLOAK_PROVISIONING_CLIENT_ID: env.KEYCLOAK_IDENTITY_STATUS_CLIENT_ID,
    KEYCLOAK_PROVISIONING_CLIENT_SECRET:
      env.KEYCLOAK_IDENTITY_STATUS_CLIENT_SECRET,
  })!;
}

export class KeycloakIdentityStatus {
  constructor(
    private readonly config: ProvisioningConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async call(url: string, init: RequestInit) {
    const target = new URL(url);
    if (
      target.origin !== new URL(this.config.issuer).origin ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error('Unexpected identity status endpoint');
    return this.request(target, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  }

  private async token() {
    const response = await this.call(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.managementClientId}:${this.config.managementClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (response.status !== 200)
      throw new Error('Identity status authentication unavailable');
    return z
      .object({
        access_token: z.string().min(16).max(16384),
        token_type: z.literal('Bearer'),
        expires_in: z.number().int().positive(),
      })
      .parse(await response.json()).access_token;
  }

  async ready() {
    await this.token();
  }

  async enabled(principal: { issuer: string; subject: string }) {
    if (
      principal.issuer !== this.config.issuer ||
      !principal.subject ||
      ['.', '..'].includes(principal.subject) ||
      principal.subject.length > 255
    )
      throw new Error('Identity status binding mismatch');
    const token = await this.token();
    const response = await this.call(
      `${this.config.adminBaseUrl}/users/${encodeURIComponent(principal.subject)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    // A missing account, denied permissions, redirects or malformed response
    // are unconfirmed observations: deny temporarily, never change local state.
    if (response.status !== 200) throw new Error('Identity status unavailable');
    const user = z
      .object({ id: z.string().min(1).max(255), enabled: z.boolean() })
      .parse(await response.json());
    if (user.id !== principal.subject)
      throw new Error('Identity status binding mismatch');
    return user.enabled;
  }
}
