import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { createDatabase, inAuthorizedTenant } from '@kinto/database';
import { testRealm } from '../infra/keycloak/test-realm';
import { AuthStore, digest } from '../apps/api/src/auth/store';
import {
  close,
  freePort,
  httpsProxy,
  mailSink,
  resetLink,
  totp,
  until,
} from './lib/keycloak-test-services';

if (existsSync('.env')) process.loadEnvFile('.env');
const adminUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (
  process.platform !== 'linux' ||
  !adminUrl ||
  !runtimeUrl ||
  !redisUrl ||
  [adminUrl, runtimeUrl].some((value) => {
    const url = new URL(value);
    return (
      !url.pathname.startsWith('/kinto_test') ||
      !['127.0.0.1', 'localhost'].includes(url.hostname)
    );
  }) ||
  !['127.0.0.1', 'localhost'].includes(new URL(redisUrl).hostname)
)
  throw new Error(
    'Keycloak verification requires Linux, local kinto_test* databases and loopback Redis',
  );
if (
  !existsSync('apps/api/dist/main.cjs') ||
  !existsSync('apps/web/.next/BUILD_ID')
)
  throw new Error('Run pnpm build before the real-provider test');

// Version and immutable digest are recorded after inspecting the upstream image.
const image =
  'quay.io/keycloak/keycloak:26.7.2@sha256:9d1f1b2b7261ff53c66cb1092dfcdc34a5fb77e81f9e6a6e75b8b6a795de8067';
const run = promisify(execFile);
const id = randomUUID().replaceAll('-', '');
const realm = `kinto_test_${id}`;
const container = `kinto-keycloak-test-${id}`;
const tenantId = randomUUID();
const userId = randomUUID();
const username = 'synthetic-owner';
const password = randomBytes(24).toString('base64url');
const newPassword = randomBytes(24).toString('base64url');
const otpSecret = randomBytes(20).toString('hex');
const clientSecret = randomBytes(32).toString('base64url');
const db = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const children: ChildProcess[] = [];
let browser: Browser | undefined;
let store: AuthStore | undefined;
let identityId: string | undefined;
let stage = 'setup';
let scenarios = 0;
await mkdir('.local/keycloak', { recursive: true, mode: 0o700 });
const directory = await mkdtemp(`${process.cwd()}/.local/keycloak/run-`);
const mail = await mailSink();
let proxy: Awaited<ReturnType<typeof httpsProxy>> | undefined;
let issuer = '';
let containerStarted = false;

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH, ...env },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}
async function scenario(name: string, check: () => Promise<void>) {
  stage = name;
  await check();
  scenarios++;
  console.log(`PASS ${name}`);
}
async function isolatedContext() {
  const context = await browser!.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
  return context;
}
async function sessionFor(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (value) => value.name === '__Host-kinto-session',
  );
  assert(
    cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax',
  );
  const session = await store!.readSession(cookie.value);
  assert(session);
  return { cookie, session };
}
async function passwordStep(page: Page, value = password) {
  await page.goto(`${proxy!.origin}/login`);
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(value);
  await page.locator('#kc-login').click();
}
let lastAcceptedTotpCounter: number | undefined;
async function otpStep(page: Page) {
  await expect(page.locator('#otp')).toBeVisible();
  // Keycloak prevents TOTP replay, so a second login must not reuse the code
  // accepted during the previous 30-second window. Also avoid generating a
  // code at the end of its window where it could expire during submission on a
  // busy CI runner.
  let counter = Math.floor(Date.now() / 30000);
  const windowRemaining = 30000 - (Date.now() % 30000);
  if (counter === lastAcceptedTotpCounter || windowRemaining < 6000) {
    await new Promise((resolve) => setTimeout(resolve, windowRemaining + 250));
    counter = Math.floor(Date.now() / 30000);
  }
  await page.locator('#otp').fill(totp(otpSecret));
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(`${proxy!.origin}/login`);
  await expect(page.getByRole('status')).toContainText('You are signed in.');
  lastAcceptedTotpCounter = counter;
}

try {
  await run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      `${directory}/key.pem`,
      '-out',
      `${directory}/cert.pem`,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { timeout: 15000 },
  );
  const apiPort = await freePort();
  const webPort = await freePort();
  const keycloakPort = await freePort();
  proxy = await httpsProxy(directory, apiPort, webPort);
  issuer = `http://localhost:${keycloakPort}/realms/${realm}`;
  const imported = testRealm({
    realm,
    origin: proxy.origin,
    smtpPort: mail.port,
    clientSecret,
    users: [
      { id: userId, username, password, otpSecret },
      {
        id: randomUUID(),
        username: 'synthetic-unprovisioned',
        password,
        otpSecret,
      },
    ],
  });
  await mkdir(`${directory}/import`, { mode: 0o700 });
  await writeFile(`${directory}/import/realm.json`, JSON.stringify(imported), {
    mode: 0o600,
  });
  // Preserve host ownership of private fixture files. Keycloak supports a
  // non-root UID with container group 0; no host file permissions are widened.
  await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--label',
      'kinto.fixture=keycloak',
      '--network',
      'host',
      '--memory',
      '1g',
      '--cpus',
      '2',
      '--user',
      `${process.getuid!()}:0`,
      '--volume',
      `${directory}/import:/opt/keycloak/data/import:ro`,
      image,
      'start-dev',
      '--http-host=127.0.0.1',
      `--http-port=${keycloakPort}`,
      `--hostname=http://localhost:${keycloakPort}`,
      '--import-realm',
    ],
    { timeout: 180000 },
  );
  containerStarted = true;
  await until(
    async () =>
      fetch(`${issuer}/.well-known/openid-configuration`)
        .then((res) => res.ok)
        .catch(() => false),
    120000,
  );
  const identity = await db.identity.create({
    data: { issuer, subject: userId },
  });
  identityId = identity.id;
  await db.tenant.create({
    data: { id: tenantId, name: 'Synthetic Keycloak tenant', employeeLimit: 5 },
  });
  await db.membership.create({
    data: { tenantId, identityId, roles: ['owner'] },
  });
  const api = start(['apps/api/dist/main.cjs'], {
    NODE_ENV: 'test',
    DATABASE_URL: runtimeUrl,
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    AUTH_MODE: 'oidc',
    AUTH_ORIGIN: proxy.origin,
    AUTH_REDIS_URL: redisUrl,
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'kinto-web',
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_MFA_PROFILE: 'keycloak-loa2-v1',
    NODE_PATH: '',
  });
  start(
    [
      'apps/web/node_modules/next/dist/bin/next',
      'start',
      'apps/web',
      '-H',
      '127.0.0.1',
      '-p',
      String(webPort),
    ],
    { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
  );
  await until(async () => {
    if (api.exitCode !== null)
      throw new Error('Built API could not initialize real provider');
    return fetch(`http://127.0.0.1:${apiPort}/api/v1/health/ready`)
      .then((res) => res.ok)
      .catch(() => false);
  });
  await until(async () =>
    fetch(`http://127.0.0.1:${webPort}/login`)
      .then((res) => res.ok)
      .catch(() => false),
  );
  store = new AuthStore(
    redisUrl,
    `kinto:auth:${digest(`${issuer}|kinto-web|${proxy.origin}`)}:`,
  );
  await store.connect();
  browser = await chromium.launch();
  const context = await isolatedContext();
  const page = await context.newPage();
  await scenario(
    'real browser password + TOTP establishes an authorized session',
    async () => {
      await passwordStep(page);
      await page.locator('#otp').fill('not-a-valid-code');
      await page.locator('#kc-login').click();
      await expect(page.locator('#otp')).toBeVisible();
      assert(
        !(await context.cookies()).some(
          (cookie) => cookie.name === '__Host-kinto-session',
        ),
      );
      await otpStep(page);
      const { session } = await sessionFor(page);
      assert.equal(session.principal.mfaVerified, true);
      assert.equal(session.principal.subject, userId);
      assert.equal(
        await inAuthorizedTenant(
          runtime,
          session.principal,
          tenantId,
          'employees.read',
          async () => true,
        ),
        true,
      );
    },
  );
  await scenario(
    'logout clears the Secure browser cookie and the Redis session',
    async () => {
      const { cookie } = await sessionFor(page);
      await page.getByRole('button', { name: 'Sign out of Kinto' }).click();
      await expect(
        page.getByRole('link', { name: 'Continue to sign in' }),
      ).toBeVisible();
      assert.equal(await store!.readSession(cookie.value), undefined);
      assert(
        !(await context.cookies()).some((value) => value.name === cookie.name),
      );
    },
  );
  await scenario(
    'signup, password grant and wildcard redirect are rejected by Keycloak',
    async () => {
      await page.getByRole('link', { name: 'Continue to sign in' }).click();
      await expect(page.locator('#username')).toBeVisible();
      await expect(page.getByRole('link', { name: /register/i })).toHaveCount(
        0,
      );
      const registration = new URL(page.url());
      registration.pathname = `${new URL(issuer).pathname}/protocol/openid-connect/registrations`;
      await page.goto(registration.href);
      await expect(page.locator('body')).toContainText(
        /registration not allowed/i,
      );
      const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'kinto-web',
          client_secret: clientSecret,
          username,
          password,
        }),
      });
      assert.equal(response.status, 400);
      const bad = new URL(`${issuer}/protocol/openid-connect/auth`);
      bad.search = new URLSearchParams({
        client_id: 'kinto-web',
        response_type: 'code',
        scope: 'openid',
        redirect_uri: 'https://attacker.invalid/callback',
      }).toString();
      await page.goto(bad.href);
      assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
      await expect(page.locator('body')).toContainText(/redirect_uri/i);
    },
  );
  await scenario(
    'a downgraded password-only token does not establish a Kinto MFA session',
    async () => {
      const fresh = await isolatedContext();
      const tab = await fresh.newPage();
      await tab.goto(`${proxy!.origin}/api/v1/auth/login`);
      const downgrade = new URL(tab.url());
      downgrade.searchParams.set(
        'claims',
        JSON.stringify({
          id_token: { acr: { essential: true, values: ['1'] } },
        }),
      );
      await tab.goto(downgrade.href);
      await tab.locator('#username').fill(username);
      await tab.locator('#password').fill(password);
      await tab.locator('#kc-login').click();
      await expect(tab.locator('body')).toContainText(
        'Request could not be completed',
      );
      assert(
        !(await fresh.cookies()).some(
          (value) => value.name === '__Host-kinto-session',
        ),
      );
      await fresh.close();
    },
  );
  await scenario(
    'unprovisioned provider users gain no Kinto identity or membership',
    async () => {
      const fresh = await isolatedContext();
      const tab = await fresh.newPage();
      await tab.goto(`${proxy!.origin}/api/v1/auth/login`);
      await tab.locator('#username').fill('synthetic-unprovisioned');
      await tab.locator('#password').fill(password);
      await tab.locator('#kc-login').click();
      await tab.locator('#otp').fill(totp(otpSecret));
      await tab.locator('#kc-login').click();
      await expect(tab.locator('body')).toContainText(
        'Request could not be completed',
      );
      assert.equal(await db.identity.count({ where: { issuer } }), 1);
      assert.equal(await db.membership.count({ where: { tenantId } }), 1);
      await fresh.close();
    },
  );
  async function requestReset(name: string) {
    // A provider SSO cookie legitimately skips account selection and sends to
    // that signed-in user. Exercise the anonymous recovery flow explicitly.
    await context.clearCookies();
    await page.goto(`${proxy!.origin}/api/v1/auth/login`);
    await page.getByRole('link', { name: /forgot password/i }).click();
    const form = page.locator('#kc-reset-password-form');
    await expect(form).toBeVisible();
    await form.locator('#username').fill(name);
    await form.locator('input[type=submit], button[type=submit]').click();
    await expect(page.locator('body')).toContainText(/receive an email/i);
    return page.locator('body').innerText();
  }
  await scenario(
    'recovery is non-enumerating and sends a reset only for an existing account',
    async () => {
      const count = mail.messages.length;
      const unknown = await requestReset('nonexistent-account');
      const known = await requestReset(username);
      assert.equal(known, unknown);
      await until(async () => mail.messages.length === count + 1);
    },
  );
  let usedLink = '';
  await scenario(
    'email reset changes the password, retains TOTP and rejects link replay',
    async () => {
      usedLink = resetLink(mail.messages.at(-1)!, issuer);
      await page.goto(usedLink);
      await page.locator('#password-new').fill(newPassword);
      await page.locator('#password-confirm').fill(newPassword);
      await page.locator('input[type=submit], button[type=submit]').click();
      await expect(page.locator('#password-new')).toHaveCount(0);
      // Email ownership/password replacement alone must not prove MFA.
      assert(
        !(await context.cookies()).some(
          (value) => value.name === '__Host-kinto-session',
        ),
      );
      await context.clearCookies();
      await passwordStep(page, password);
      await expect(
        page.getByText('Invalid username or password.', { exact: true }),
      ).toBeVisible();
      await page.locator('#password').fill(newPassword);
      await page.locator('#kc-login').click();
      await otpStep(page);
      const { session } = await sessionFor(page);
      assert.equal(session.principal.mfaVerified, true);
      const replay = await isolatedContext();
      const tab = await replay.newPage();
      await tab.goto(usedLink);
      await expect(tab.locator('#password-new')).toHaveCount(0);
      await expect(tab.locator('body')).toContainText(
        /no longer valid|invalid|expired/i,
      );
      await replay.close();
      await db.membership.updateMany({
        where: { tenantId },
        data: { status: 'revoked' },
      });
      await assert.rejects(
        inAuthorizedTenant(
          runtime,
          session.principal,
          tenantId,
          'employees.read',
          async () => true,
        ),
        /FORBIDDEN/,
      );
    },
  );
  await scenario('expired reset links cannot change a password', async () => {
    await context.clearCookies();
    const count = mail.messages.length;
    await requestReset(username);
    await until(async () => mail.messages.length === count + 1);
    const link = resetLink(mail.messages.at(-1)!, issuer);
    await new Promise((resolve) => setTimeout(resolve, 22000));
    await page.goto(link);
    await expect(page.locator('#password-new')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(
      /no longer valid|invalid|expired/i,
    );
  });
  await writeFile(
    `${directory}/report.json`,
    JSON.stringify(
      {
        status: 'passed',
        scenarios,
        image,
        scope:
          'synthetic real Keycloak browser/TOTP/email verification; not production approval',
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    `Keycloak verification passed: ${scenarios} scenarios. Private report: ${directory}/report.json`,
  );
} catch (error) {
  const message = String(error)
    .replaceAll(password, '[password]')
    .replaceAll(newPassword, '[password]')
    .replaceAll(clientSecret, '[client-secret]')
    .replaceAll(otpSecret, '[otp-secret]')
    .replace(/https?:\/\/\S+/g, '[url]');
  await writeFile(`${directory}/failure.txt`, message, { mode: 0o600 });
  console.error(
    `Keycloak verification failed during: ${stage}. No credentials or recovery links printed.`,
  );
  if (containerStarted) {
    const result = await run('docker', ['logs', container]).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    await writeFile(
      `${directory}/keycloak.log`,
      result.stdout + result.stderr,
      { mode: 0o600 },
    );
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children)
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  if (containerStarted) await run('docker', ['stop', '--time', '5', container]);
  if (proxy) {
    proxy.server.closeAllConnections();
    await close(proxy.server);
  }
  await close(mail.server);
  if (store) {
    const keys = await store.redis.keys(
      `kinto:auth:${digest(`${issuer}|kinto-web|${proxy!.origin}`)}:*`,
    );
    if (keys.length) await store.redis.del(...keys);
    store.close();
  }
  await db.membership.deleteMany({ where: { tenantId } });
  await db.tenant.deleteMany({ where: { id: tenantId } });
  if (identityId) await db.identity.delete({ where: { id: identityId } });
  await Promise.all([db.$disconnect(), runtime.$disconnect()]);
  // Remove generated passwords, OTP credentials and TLS key, keep only private
  // diagnostic report/log. The fixture never overwrites the user's .env.
  await rm(`${directory}/import`, { recursive: true, force: true });
  await rm(`${directory}/key.pem`, { force: true });
  await rm(`${directory}/cert.pem`, { force: true });
  await chmod(directory, 0o700);
}
