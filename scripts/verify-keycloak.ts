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
const employeeUserId = randomUUID();
const employeeId = randomUUID();
const username = 'synthetic-owner';
const employeeUsername = 'synthetic-invited-employee';
const employeeEmail = `${employeeUsername}@kinto.test`;
const password = randomBytes(24).toString('base64url');
const newPassword = randomBytes(24).toString('base64url');
const otpSecret = randomBytes(20).toString('hex');
const clientSecret = randomBytes(32).toString('base64url');
const provisioningClientSecret = randomBytes(32).toString('base64url');
const invitedEmail = 'invited-owner@kinto.test';
const invitedPassword = `Kinto!${randomBytes(18).toString('hex')}Aa1`;
const db = createDatabase(adminUrl);
const runtime = createDatabase(runtimeUrl);
const children: ChildProcess[] = [];
let browser: Browser | undefined;
let preResetContext: Awaited<ReturnType<Browser['newContext']>> | undefined;
let store: AuthStore | undefined;
let identityId: string | undefined;
let invitedIdentityId: string | undefined;
let employeeIdentityId: string | undefined;
let invitedTenantId: string | undefined;
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
function decodeBase32(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value
    .replaceAll(' ', '')
    .replaceAll('=', '')
    .toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid synthetic TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  return Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
      Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2),
    ),
  );
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
    backchannelUrl: `http://127.0.0.1:${apiPort}/api/v1/auth/backchannel-logout`,
    clientSecret,
    provisioningClientSecret,
    users: [
      { id: userId, username, password, otpSecret },
      {
        id: randomUUID(),
        username: 'synthetic-unprovisioned',
        password,
        otpSecret,
      },
      {
        id: employeeUserId,
        username: employeeUsername,
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
  const managementTokenResponse = await fetch(
    `${issuer}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`kinto-provisioner:${provisioningClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    },
  );
  assert.equal(managementTokenResponse.status, 200);
  const managementToken = String(
    ((await managementTokenResponse.json()) as { access_token?: unknown })
      .access_token,
  );
  const managementClaims = JSON.parse(
    Buffer.from(managementToken.split('.')[1] ?? '', 'base64url').toString(),
  ) as { resource_access?: Record<string, { roles?: string[] }> };
  assert(
    managementClaims.resource_access?.['realm-management']?.roles?.includes(
      'manage-users',
    ),
  );
  const identity = await db.identity.create({
    data: { issuer, subject: userId },
  });
  identityId = identity.id;
  await db.platformOperator.create({ data: { identityId } });
  await db.tenant.create({
    data: { id: tenantId, name: 'Synthetic Keycloak tenant', employeeLimit: 5 },
  });
  await db.membership.create({
    data: { tenantId, identityId, roles: ['owner'] },
  });
  await db.employee.create({
    data: {
      id: employeeId,
      tenantId,
      employeeNumber: 'KEYCLOAK-EMPLOYEE-001',
      name: 'Synthetic invited employee',
      status: 'active',
    },
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
    ACCOUNT_PROVISIONING_MODE: 'keycloak',
    KEYCLOAK_PROVISIONING_CLIENT_ID: 'kinto-provisioner',
    KEYCLOAK_PROVISIONING_CLIENT_SECRET: provisioningClientSecret,
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
    `kinto:auth:v2:${digest(`${issuer}|kinto-web|${proxy.origin}`)}:`,
  );
  await store.connect();
  browser = await chromium.launch();
  const context = await isolatedContext();
  const page = await context.newPage();
  let usedLink = '';
  let preResetSessionToken = '';
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
    'platform provisioning delivers setup actions and activates exactly one initial owner',
    async () => {
      const { cookie, session } = await sessionFor(page);
      const messageCount = mail.messages.length;
      const response = await fetch(
        `http://127.0.0.1:${apiPort}/api/v1/platform/tenants`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `__Host-kinto-session=${cookie.value}`,
            Origin: proxy!.origin,
            'X-CSRF-Token': session.csrf,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            companyName: 'Synthetic invited company',
            employeeLimit: 5,
            billingMode: 'free',
            initialOwnerEmail: invitedEmail,
          }),
        },
      );
      assert.equal(response.status, 202);
      const result = (await response.json()) as {
        tenantId: string;
        provisioningRequestId: string;
        status: string;
      };
      invitedTenantId = result.tenantId;
      assert.equal(result.status, 'pending_activation');
      assert(!JSON.stringify(result).includes(invitedEmail));
      assert.equal(
        await db.membership.count({ where: { tenantId: invitedTenantId } }),
        0,
      );
      await until(async () => mail.messages.length === messageCount + 1);

      const invitationContext = await isolatedContext();
      const invitationPage = await invitationContext.newPage();
      await invitationPage.goto(resetLink(mail.messages.at(-1)!, issuer));
      let invitedOtpSecret: Buffer | undefined;
      let passwordConfigured = false;
      let otpConfigured = false;
      let invitedAcceptedTotpCounter: number | undefined;
      const actionTrace: string[] = [];
      for (let step = 0; step < 24; step++) {
        if (
          (await invitationContext.cookies()).some(
            (value) => value.name === '__Host-kinto-session',
          )
        ) {
          actionTrace.push('session');
          break;
        }
        if (
          new URL(invitationPage.url()).origin === proxy!.origin &&
          (await invitationPage.getByRole('status').count()) &&
          (await invitationPage.getByRole('status').innerText()).includes(
            'You are signed in.',
          )
        )
          break;
        if (await invitationPage.locator('#password-new').count()) {
          actionTrace.push('password-setup');
          await invitationPage.locator('#password-new').fill(invitedPassword);
          await invitationPage
            .locator('#password-confirm')
            .fill(invitedPassword);
          await invitationPage
            .locator('input[type=submit], button[type=submit]')
            .click();
          await expect(invitationPage.locator('#password-new')).toHaveCount(0);
          passwordConfigured = true;
          continue;
        }
        const profileForm = invitationPage.locator('#kc-update-profile-form');
        if (await profileForm.count()) {
          actionTrace.push('profile-setup');
          if (await profileForm.locator('#firstName').count())
            await profileForm.locator('#firstName').fill('Synthetic');
          if (await profileForm.locator('#lastName').count())
            await profileForm.locator('#lastName').fill('Owner');
          await profileForm
            .locator('input[type=submit], button[type=submit]')
            .click();
          continue;
        }
        const totpSetupForm = invitationPage.locator('#kc-totp-settings-form');
        if (await totpSetupForm.count()) {
          actionTrace.push('totp-setup');
          const visibleSecret = invitationPage.locator('#kc-totp-secret-key');
          invitedOtpSecret = (await visibleSecret.count())
            ? decodeBase32(await visibleSecret.innerText())
            : Buffer.from(
                await totpSetupForm.locator('#totpSecret').inputValue(),
              );
          const setupWindowRemaining = 30000 - (Date.now() % 30000);
          if (setupWindowRemaining < 6000)
            await invitationPage.waitForTimeout(setupWindowRemaining + 250);
          const setupCounter = Math.floor(Date.now() / 30000);
          await totpSetupForm.locator('#totp').fill(totp(invitedOtpSecret));
          if (await totpSetupForm.locator('#userLabel').count())
            await totpSetupForm.locator('#userLabel').fill('Synthetic owner');
          await totpSetupForm
            .locator('input[type=submit], button[type=submit]')
            .click();
          await expect(totpSetupForm).toHaveCount(0);
          invitedAcceptedTotpCounter = setupCounter;
          otpConfigured = true;
          continue;
        }
        if (await invitationPage.locator('#username').count()) {
          actionTrace.push('login-password');
          assert(
            passwordConfigured && otpConfigured,
            'Keycloak requested credentials before completing invited setup actions',
          );
          await invitationPage.locator('#username').fill(invitedEmail);
          await invitationPage.locator('#password').fill(invitedPassword);
          await invitationPage.locator('#kc-login').click();
          assert.equal(
            await invitationPage
              .getByText('Invalid username or password.', { exact: true })
              .count(),
            0,
            'Keycloak rejected the password accepted by its setup action',
          );
          continue;
        }
        if (await invitationPage.locator('#otp').count()) {
          actionTrace.push('login-totp');
          assert(invitedOtpSecret);
          let loginCounter = Math.floor(Date.now() / 30000);
          const loginWindowRemaining = 30000 - (Date.now() % 30000);
          if (
            loginCounter === invitedAcceptedTotpCounter ||
            loginWindowRemaining < 6000
          ) {
            await invitationPage.waitForTimeout(loginWindowRemaining + 250);
            loginCounter = Math.floor(Date.now() / 30000);
          }
          await invitationPage.locator('#otp').fill(totp(invitedOtpSecret));
          await invitationPage.locator('#kc-login').click();
          invitedAcceptedTotpCounter = loginCounter;
          continue;
        }
        const actionLink = invitationPage.locator('#kc-info-message a');
        if (await actionLink.count()) {
          actionTrace.push('action-info-link');
          await actionLink.first().click();
          continue;
        }
        const submit = invitationPage.locator(
          'input[type=submit], button[type=submit]',
        );
        if (await submit.count()) {
          const formId =
            (await submit
              .first()
              .locator('xpath=ancestor::form[1]')
              .getAttribute('id')) ?? 'unknown-form';
          const inputIds = await invitationPage
            .locator('input[id]')
            .evaluateAll((inputs) =>
              inputs
                .map((input) => input.id)
                .filter(Boolean)
                .slice(0, 8),
            );
          actionTrace.push(`generic-submit(${formId}:${inputIds.join(',')})`);
          await submit.first().click();
          continue;
        }
        actionTrace.push('wait');
        await invitationPage.waitForTimeout(250);
      }
      assert(
        (await invitationContext.cookies()).some(
          (value) => value.name === '__Host-kinto-session',
        ),
        `Invited setup ended without a Kinto session: ${actionTrace.join(' > ')}`,
      );
      const invitedSession = await sessionFor(invitationPage);
      const membership = await db.membership.findFirstOrThrow({
        where: { tenantId: invitedTenantId },
      });
      invitedIdentityId = membership.identityId;
      assert.equal(invitedSession.session.identityId, invitedIdentityId);
      assert.deepEqual(membership.roles, ['owner']);
      assert.equal(
        await db.membership.count({ where: { tenantId: invitedTenantId } }),
        1,
      );
      assert.equal(
        (
          await db.companyProvisioningRequest.findUniqueOrThrow({
            where: { id: result.provisioningRequestId },
          })
        ).status,
        'active',
      );
      assert.equal(
        (
          await db.ownerInvitation.findUniqueOrThrow({
            where: { requestId: result.provisioningRequestId },
          })
        ).status,
        'accepted',
      );
      await invitationContext.close();
    },
  );
  await scenario(
    'company owner delivers and activates one fixed employee account',
    async () => {
      const { cookie, session } = await sessionFor(page);
      const messageCount = mail.messages.length;
      const response = await fetch(
        `http://127.0.0.1:${apiPort}/api/v1/tenants/${tenantId}/employees/${employeeId}/account-invitations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `__Host-kinto-session=${cookie.value}`,
            Origin: proxy!.origin,
            'X-CSRF-Token': session.csrf,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({ email: employeeEmail }),
        },
      );
      assert.equal(response.status, 202);
      const result = (await response.json()) as {
        accountRequestId: string;
        status: string;
      };
      assert.equal(result.status, 'pending_activation');
      assert(!JSON.stringify(result).includes(employeeEmail));
      await until(async () => mail.messages.length === messageCount + 1);
      assert.equal(await db.membership.count({ where: { tenantId } }), 1);

      const employeeContext = await isolatedContext();
      const employeePage = await employeeContext.newPage();
      await employeePage.goto(`${proxy!.origin}/login`);
      await employeePage
        .getByRole('link', { name: 'Continue to sign in' })
        .click();
      await employeePage.locator('#username').fill(employeeUsername);
      await employeePage.locator('#password').fill(password);
      await employeePage.locator('#kc-login').click();
      await expect(employeePage.locator('#otp')).toBeVisible();
      const windowRemaining = 30000 - (Date.now() % 30000);
      if (windowRemaining < 6000)
        await employeePage.waitForTimeout(windowRemaining + 250);
      await employeePage.locator('#otp').fill(totp(otpSecret));
      await employeePage.locator('#kc-login').click();
      await expect(employeePage).toHaveURL(`${proxy!.origin}/login`);
      const employeeSession = await sessionFor(employeePage);
      const membership = await db.membership.findFirstOrThrow({
        where: { tenantId, identityId: employeeSession.session.identityId },
      });
      employeeIdentityId = membership.identityId;
      assert.deepEqual(membership.roles, ['employee']);
      assert.equal(membership.status, 'active');
      assert.deepEqual(
        await db.employeeIdentityLink.findUniqueOrThrow({
          where: { tenantId_employeeId: { tenantId, employeeId } },
          select: { identityId: true, membershipId: true },
        }),
        { identityId: employeeIdentityId, membershipId: membership.id },
      );
      assert.equal(
        (
          await db.employeeAccountRequest.findUniqueOrThrow({
            where: { id: result.accountRequestId },
          })
        ).status,
        'active',
      );
      assert.equal(
        (
          await db.employeeInvitation.findUniqueOrThrow({
            where: { requestId: result.accountRequestId },
          })
        ).status,
        'accepted',
      );
      await employeeContext.close();
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
      const identityCount = await db.identity.count({ where: { issuer } });
      const membershipCount = await db.membership.count();
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
      assert.equal(
        await db.identity.count({ where: { issuer } }),
        identityCount,
      );
      assert.equal(await db.membership.count(), membershipCount);
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
      preResetContext = await isolatedContext();
      const signedIn = await preResetContext.newPage();
      await passwordStep(signedIn);
      await otpStep(signedIn);
      preResetSessionToken = (await sessionFor(signedIn)).cookie.value;
      const count = mail.messages.length;
      const unknown = await requestReset('nonexistent-account');
      const known = await requestReset(username);
      assert.equal(known, unknown);
      await until(async () => mail.messages.length === count + 1);
    },
  );
  await scenario(
    'email reset changes the password, retains TOTP and rejects link replay',
    async () => {
      usedLink = resetLink(mail.messages.at(-1)!, issuer);
      await page.goto(usedLink);
      await page.locator('#password-new').fill(newPassword);
      await page.locator('#password-confirm').fill(newPassword);
      const logoutOtherSessions = page.locator('input[name="logout-sessions"]');
      await expect(logoutOtherSessions).toHaveCount(1);
      await logoutOtherSessions.check();
      await page.locator('input[type=submit], button[type=submit]').click();
      await expect(page.locator('#password-new')).toHaveCount(0);
      await until(
        async () =>
          (await store!.readSession(preResetSessionToken)) === undefined,
      );
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
      await preResetContext!.close();
      preResetContext = undefined;
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
  const message = (
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  )
    .replaceAll(password, '[password]')
    .replaceAll(newPassword, '[password]')
    .replaceAll(invitedPassword, '[password]')
    .replaceAll(clientSecret, '[client-secret]')
    .replaceAll(provisioningClientSecret, '[client-secret]')
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
  await preResetContext?.close();
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
      `kinto:auth:v2:${digest(`${issuer}|kinto-web|${proxy!.origin}`)}:*`,
    );
    if (keys.length) await store.redis.del(...keys);
    store.close();
  }
  if (invitedTenantId && !invitedIdentityId)
    invitedIdentityId = (
      await db.ownerInvitation.findFirst({
        where: { tenantId: invitedTenantId },
        select: { identityId: true },
      })
    )?.identityId;
  if (!employeeIdentityId)
    employeeIdentityId = (
      await db.employeeInvitation.findFirst({
        where: { tenantId },
        select: { identityId: true },
      })
    )?.identityId;
  const fixtureIdentityIds = [
    identityId,
    invitedIdentityId,
    employeeIdentityId,
  ].filter((value): value is string => Boolean(value));
  if (fixtureIdentityIds.length)
    await db.platformAuditEvent.deleteMany({
      where: { actorId: { in: fixtureIdentityIds } },
    });
  const fixtureTenantIds = [tenantId, invitedTenantId].filter(
    (value): value is string => Boolean(value),
  );
  await db.auditEvent.deleteMany({
    where: { tenantId: { in: fixtureTenantIds } },
  });
  await db.employeeIdentityLink.deleteMany({
    where: { tenantId: { in: fixtureTenantIds } },
  });
  await db.employeeInvitation.deleteMany({
    where: { tenantId: { in: fixtureTenantIds } },
  });
  await db.employeeAccountRequest.deleteMany({
    where: { tenantId: { in: fixtureTenantIds } },
  });
  await db.membership.deleteMany({
    where: { tenantId: { in: fixtureTenantIds } },
  });
  await db.employee.deleteMany({
    where: { tenantId: { in: fixtureTenantIds } },
  });
  if (invitedTenantId) {
    await db.ownerInvitation.deleteMany({
      where: { tenantId: invitedTenantId },
    });
    await db.companyProvisioningRequest.deleteMany({
      where: { tenantId: invitedTenantId },
    });
  }
  await db.tenant.deleteMany({ where: { id: { in: fixtureTenantIds } } });
  if (identityId)
    await db.platformOperator.deleteMany({ where: { identityId } });
  if (fixtureIdentityIds.length)
    await db.identity.deleteMany({ where: { id: { in: fixtureIdentityIds } } });
  await Promise.all([db.$disconnect(), runtime.$disconnect()]);
  // Remove generated passwords, OTP credentials and TLS key, keep only private
  // diagnostic report/log. The fixture never overwrites the user's .env.
  await rm(`${directory}/import`, { recursive: true, force: true });
  await rm(`${directory}/key.pem`, { force: true });
  await rm(`${directory}/cert.pem`, { force: true });
  await chmod(directory, 0o700);
}
