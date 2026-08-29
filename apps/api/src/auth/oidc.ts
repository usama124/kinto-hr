import * as client from 'openid-client';
import { z } from 'zod';
import { authenticatedIdentitySchema } from '@kinto/contracts';
import { type AuthConfig } from './config';
import { type LoginTransaction } from './store';

export class OidcProvider {
  private constructor(
    private readonly settings: AuthConfig,
    private readonly config: client.Configuration,
  ) {}
  static async connect(settings: AuthConfig) {
    const issuer = new URL(settings.issuer);
    const config = await client.discovery(
      issuer,
      settings.clientId,
      {
        client_secret: settings.clientSecret,
        id_token_signed_response_alg: 'RS256',
        [client.clockTolerance]: 0,
      },
      client.ClientSecretPost(settings.clientSecret),
      {
        timeout: 5,
        execute: settings.local ? [client.allowInsecureRequests] : [],
        // No metadata/token/JWKS redirects or endpoint-origin substitution.
        [client.customFetch]: (input, options) => {
          const url = new URL(input);
          if (url.origin !== issuer.origin || url.username || url.password)
            throw new Error('Unexpected identity endpoint');
          const body =
            options.body instanceof Uint8Array
              ? new Uint8Array(options.body).buffer
              : options.body;
          return fetch(input, { ...options, body, redirect: 'error' });
        },
      },
    );
    const metadata = config.serverMetadata();
    for (const value of [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.jwks_uri,
    ]) {
      if (
        !value ||
        new URL(value).origin !== issuer.origin ||
        new URL(value).hash ||
        new URL(value).username ||
        new URL(value).password
      )
        throw new Error('Invalid identity provider endpoints');
    }
    if (
      metadata.issuer !== settings.issuer ||
      !config.serverMetadata().supportsPKCE('S256')
    )
      throw new Error(
        'Identity provider must support S256 PKCE and exact issuer',
      );
    client.enableNonRepudiationChecks(config);
    return new OidcProvider(settings, config);
  }
  async begin() {
    const transaction = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
    };
    const url = client.buildAuthorizationUrl(this.config, {
      redirect_uri: `${this.settings.origin}/api/v1/auth/callback`,
      response_type: 'code',
      scope: 'openid',
      response_mode: 'query',
      code_challenge: await client.calculatePKCECodeChallenge(
        transaction.verifier,
      ),
      code_challenge_method: 'S256',
      state: transaction.state,
      nonce: transaction.nonce,
      max_age: '300',
      ...(this.settings.mfaProfile === 'keycloak-loa2-v1'
        ? {
            claims: JSON.stringify({
              id_token: { acr: { essential: true, values: ['2'] } },
            }),
          }
        : {}),
    });
    return { transaction, url: url.href };
  }
  async complete(url: URL, transaction: LoginTransaction) {
    const tokens = await client.authorizationCodeGrant(this.config, url, {
      pkceCodeVerifier: transaction.verifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
      maxAge: 300,
    });
    const claims = tokens.claims();
    const authTime = z.number().int().nonnegative().parse(claims?.auth_time);
    if (authTime > Math.floor(Date.now() / 1000))
      throw new Error('Invalid authentication time');
    const requiresMfa = this.settings.mfaProfile === 'keycloak-loa2-v1';
    if (requiresMfa && claims?.acr !== '2')
      throw new Error('Required authentication assurance was not met');
    const principal = authenticatedIdentitySchema.parse({
      issuer: claims?.iss,
      subject: claims?.sub,
      // This explicit profile refers to the reviewed Keycloak LoA flow, not a
      // universal meaning for acr=2. Generic providers remain unverified.
      mfaVerified: requiresMfa,
    });
    return { principal, authTime };
  }
}
