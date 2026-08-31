// Disposable synthetic realm only. No fixed password, user or administrator is
// shipped. Production setup/provisioning must have a separately approved workflow.
export interface KeycloakFixture {
  realm: string;
  origin: string;
  smtpPort: number;
  backchannelUrl: string;
  clientSecret: string;
  provisioningClientSecret?: string;
  users: {
    id: string;
    username: string;
    password: string;
    otpSecret?: string;
  }[];
}
export function testRealm(input: KeycloakFixture) {
  if (
    !/^kinto_test_[a-f0-9]{32}$/.test(input.realm) ||
    new URL(input.origin).hostname !== 'localhost' ||
    new URL(input.origin).protocol !== 'https:' ||
    new URL(input.backchannelUrl).hostname !== '127.0.0.1' ||
    new URL(input.backchannelUrl).protocol !== 'http:'
  )
    throw new Error('Synthetic local realm required');
  const execution = (
    authenticator: string,
    priority: number,
    authenticatorConfig?: string,
  ) => ({
    authenticator,
    priority,
    requirement: 'REQUIRED',
    authenticatorFlow: false,
    userSetupAllowed: false,
    ...(authenticatorConfig ? { authenticatorConfig } : {}),
  });
  return {
    realm: input.realm,
    enabled: true,
    sslRequired: 'none',
    registrationAllowed: false,
    registrationEmailAsUsername: false,
    resetPasswordAllowed: true,
    rememberMe: false,
    editUsernameAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    bruteForceProtected: true,
    failureFactor: 10,
    passwordPolicy: 'length(12)',
    actionTokenGeneratedByUserLifespan: 20,
    accessCodeLifespan: 60,
    accessTokenLifespan: 300,
    browserFlow: 'kinto-loa',
    resetCredentialsFlow: 'kinto-reset-password-only',
    attributes: { 'acr.loa.map': JSON.stringify({ '1': 1, '2': 2 }) },
    smtpServer: {
      host: '127.0.0.1',
      port: String(input.smtpPort),
      from: 'noreply@kinto.test',
      auth: 'false',
      ssl: 'false',
      starttls: 'false',
    },
    authenticatorConfig: [1, 2].map((level) => ({
      alias: `kinto-level-${level}`,
      config: { 'loa-condition-level': String(level), 'loa-max-age': '0' },
    })),
    authenticationFlows: [
      {
        alias: 'kinto-loa',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
        authenticationExecutions: [1, 2].map((level) => ({
          flowAlias: `kinto-level-${level}`,
          authenticatorFlow: true,
          requirement: 'CONDITIONAL',
          priority: level * 10,
        })),
      },
      ...[1, 2].map((level) => ({
        alias: `kinto-level-${level}`,
        providerId: 'basic-flow',
        topLevel: false,
        builtIn: false,
        authenticationExecutions: [
          execution(
            'conditional-level-of-authentication',
            10,
            `kinto-level-${level}`,
          ),
          execution(
            level === 1 ? 'auth-username-password-form' : 'auth-otp-form',
            20,
          ),
        ],
      })),
      {
        alias: 'kinto-reset-password-only',
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
        authenticationExecutions: [
          execution('reset-credentials-choose-user', 10),
          execution('reset-credential-email', 20),
          execution('reset-password', 30),
        ],
      },
    ],
    clients: [
      {
        clientId: 'kinto-web',
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        secret: input.clientSecret,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: [
          `${input.origin}/api/v1/auth/callback`,
          `${input.origin}/api/v1/auth/login`,
        ],
        webOrigins: [input.origin],
        fullScopeAllowed: false,
        attributes: {
          'pkce.code.challenge.method': 'S256',
          'id.token.signed.response.alg': 'RS256',
          'default.acr.values': '2',
          'backchannel.logout.url': input.backchannelUrl,
          'backchannel.logout.session.required': 'true',
        },
        protocolMappers: [
          {
            name: 'acr',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-acr-mapper',
            config: { 'id.token.claim': 'true', 'access.token.claim': 'true' },
          },
        ],
      },
      ...(input.provisioningClientSecret
        ? [
            {
              clientId: 'kinto-provisioner',
              enabled: true,
              protocol: 'openid-connect',
              publicClient: false,
              secret: input.provisioningClientSecret,
              standardFlowEnabled: false,
              directAccessGrantsEnabled: false,
              implicitFlowEnabled: false,
              serviceAccountsEnabled: true,
              // Disposable fixture only. Production must explicitly scope the
              // service account to its reviewed user-management permissions.
              fullScopeAllowed: true,
            },
          ]
        : []),
    ],
    users: [
      ...input.users.map((user) => ({
        id: user.id,
        username: user.username,
        enabled: true,
        email: `${user.username}@kinto.test`,
        emailVerified: true,
        firstName: 'Synthetic',
        lastName: 'Fixture',
        credentials: [
          { type: 'password', value: user.password, temporary: false },
          ...(user.otpSecret
            ? [
                {
                  type: 'otp',
                  userLabel: 'Synthetic TOTP',
                  secretData: JSON.stringify({ value: user.otpSecret }),
                  credentialData: JSON.stringify({
                    subType: 'totp',
                    digits: 6,
                    counter: 0,
                    period: 30,
                    algorithm: 'HmacSHA1',
                  }),
                },
              ]
            : []),
        ],
      })),
      ...(input.provisioningClientSecret
        ? [
            {
              username: 'service-account-kinto-provisioner',
              enabled: true,
              serviceAccountClientId: 'kinto-provisioner',
              clientRoles: {
                'realm-management': [
                  'manage-users',
                  'query-users',
                  'view-users',
                ],
              },
            },
          ]
        : []),
    ],
  };
}
