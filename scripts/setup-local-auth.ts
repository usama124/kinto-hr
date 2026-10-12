import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@kinto/database';
import { loopbackRealm } from '../infra/keycloak/loopback-realm';
import { localEnv, updateLocalEnv } from './lib/local-auth';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const directory = `${root}.local/auth`;
const configFile = `${directory}/config.json`;
const issuerOrigin = 'http://localhost:8080';
const origin = 'https://localhost:3443';
const secret = () => randomBytes(32).toString('base64url');
const compose = [
  'compose',
  '--env-file',
  `${directory}/services.env`,
  '-f',
  'infra/local-auth.compose.yaml',
  '-p',
  'kinto-local-auth',
];
interface LocalConfig {
  realm: string;
  subject: string;
  username: string;
  password: string;
  webSecret: string;
  provisionerSecret: string;
  statusSecret: string;
  keycloakAdminPassword: string;
}
async function main() {
  if (!process.argv.includes('--confirm-local-setup'))
    throw new Error(
      'Pass --confirm-local-setup to authorize local provisioning',
    );
  if (process.platform !== 'linux' || !process.getuid)
    throw new Error('This local setup requires Linux');
  const source = await readFile('.env', 'utf8');
  const env = localEnv(source);
  const existing = existsSync(configFile);
  const config: LocalConfig = existing
    ? JSON.parse(await readFile(configFile, 'utf8'))
    : {
        realm: `kinto_local_${randomUUID().replaceAll('-', '')}`,
        subject: randomUUID(),
        username: 'platform-admin',
        password: secret(),
        webSecret: secret(),
        provisionerSecret: secret(),
        statusSecret: secret(),
        keycloakAdminPassword: secret(),
      };
  const issuer = `${issuerOrigin}/realms/${config.realm}`;
  if (
    env.AUTH_MODE === 'oidc' &&
    (!existing || env.OIDC_ISSUER !== issuer || env.AUTH_ORIGIN !== origin)
  )
    throw new Error('Refusing to replace an existing authentication provider');
  // Refuse replacement BEFORE writing secrets or configuring another provider.
  const database = createDatabase(env.MIGRATION_DATABASE_URL!);
  try {
    const operators = await database.platformOperator.findMany({
      include: { identity: true },
    });
    if (
      operators.length &&
      (!existing ||
        operators.length !== 1 ||
        operators[0].status !== 'active' ||
        operators[0].identity.status !== 'active' ||
        operators[0].identity.issuer !== issuer ||
        operators[0].identity.subject !== config.subject)
    )
      throw new Error('An unrelated platform operator already exists');
  } finally {
    await database.$disconnect();
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const child of ['import', 'keycloak-data'])
    await mkdir(`${directory}/${child}`, { mode: 0o700, recursive: true });
  if (!existing) {
    await writeFile(configFile, JSON.stringify(config), {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(`${directory}/env-before-auth`, source, {
      mode: 0o600,
      flag: 'wx',
    });
    const realm = loopbackRealm({
      realm: config.realm,
      origin,
      smtpPort: 1025,
      backchannelUrl: 'http://127.0.0.1:4000/api/v1/auth/backchannel-logout',
      clientSecret: config.webSecret,
      provisioningClientSecret: config.provisionerSecret,
      identityStatusClientSecret: config.statusSecret,
      users: [
        {
          id: config.subject,
          username: config.username,
          email: 'platform-admin@kinto.test',
          password: config.password,
          requiredActions: ['CONFIGURE_TOTP'],
        },
      ],
    });
    await writeFile(`${directory}/import/realm.json`, JSON.stringify(realm), {
      mode: 0o600,
    });
    await writeFile(
      `${directory}/credentials.txt`,
      `LOCAL DEVELOPMENT ONLY — never publish this file.\n\nKinto: ${origin}/login\nUsername: ${config.username}\nInitial password: ${config.password}\n\nAt first login, scan Keycloak's QR code with your authenticator app.\nUse a fresh authenticator code for later logins.\n\nEmail inbox: http://127.0.0.1:8025\nKeycloak console: ${issuerOrigin}/admin/\nConsole username: kinto-local-admin\nConsole initial password: ${config.keycloakAdminPassword}\n\nPasswords changed in Keycloak are not updated in this initial-credentials file.\n`,
      { mode: 0o600 },
    );
  }
  await writeFile(
    `${directory}/services.env`,
    `LOCAL_AUTH_UID=${process.getuid()}\nLOCAL_KEYCLOAK_ADMIN_PASSWORD=${config.keycloakAdminPassword}\n`,
    { mode: 0o600 },
  );
  if (!existsSync(`${directory}/key.pem`)) {
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '90',
      '-keyout',
      `${directory}/key.pem`,
      '-out',
      `${directory}/cert.pem`,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ]);
    await chmod(`${directory}/key.pem`, 0o600);
  }
  console.log('Starting persistent local Keycloak and email inbox…');
  await run('docker', [...compose, 'up', '-d'], { timeout: 180000 });
  const deadline = Date.now() + 120000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    })
      .then((res) => res.ok)
      .catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Local Keycloak did not become ready');
  // Verify the imported subject using the provisioner, never bind an invented ID.
  const tokenResponse = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'kinto-provisioner',
      client_secret: config.provisionerSecret,
    }),
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!tokenResponse.ok)
    throw new Error('Local provisioner authentication failed');
  const token = (await tokenResponse.json()) as { access_token: string };
  const userResponse = await fetch(
    `${issuerOrigin}/admin/realms/${config.realm}/users/${config.subject}`,
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    },
  );
  if (!userResponse.ok)
    throw new Error('Local provider subject is unavailable');
  const user = (await userResponse.json()) as {
    id: string;
    username: string;
    enabled: boolean;
  };
  if (
    user.id !== config.subject ||
    user.username !== config.username ||
    !user.enabled
  )
    throw new Error(
      'Local provider account does not match the approved operator',
    );
  await run('pnpm', ['db:bootstrap:operator'], {
    env: {
      ...process.env,
      ...env,
      PLATFORM_BOOTSTRAP_ISSUER: issuer,
      PLATFORM_BOOTSTRAP_SUBJECT: config.subject,
      PLATFORM_BOOTSTRAP_CONFIRM: 'bootstrap-first-platform-operator',
    },
  });
  const authRedis = new URL(env.REDIS_URL!);
  authRedis.pathname = '/1';
  await writeFile(
    '.env',
    updateLocalEnv(source, {
      NODE_ENV: 'development',
      AUTH_MODE: 'oidc',
      AUTH_ORIGIN: origin,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'kinto-web',
      OIDC_CLIENT_SECRET: config.webSecret,
      OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
      AUTH_REDIS_URL: authRedis.href,
      AUTH_LOGOUT_MODE: 'durable',
      ACCOUNT_PROVISIONING_MODE: 'keycloak',
      KEYCLOAK_PROVISIONING_CLIENT_ID: 'kinto-provisioner',
      KEYCLOAK_PROVISIONING_CLIENT_SECRET: config.provisionerSecret,
      IDENTITY_STATUS_MODE: 'keycloak',
      KEYCLOAK_IDENTITY_STATUS_CLIENT_ID: 'kinto-identity-status',
      KEYCLOAK_IDENTITY_STATUS_CLIENT_SECRET: config.statusSecret,
    }),
    { mode: 0o600 },
  );
  await chmod('.env', 0o600);
  console.log(
    'Local authentication configured; first operator verified and bootstrapped.',
  );
  console.log(
    'Run pnpm local:dev; credentials are in .local/auth/credentials.txt.',
  );
}
main().catch(() => {
  // Underlying database/CLI errors may contain credentials; do not print them.
  console.error(
    'Local auth setup failed. Existing operator/provider conflicts, Docker, database or ports need review. No authentication bypass was enabled.',
  );
  process.exitCode = 1;
});
