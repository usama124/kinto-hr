import { expect, test } from '@playwright/test';
test('workspace reflects actual service readiness and fits the viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your people. One workspace.' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Connected · runtime role verified',
  );
  await expect(
    page.getByText('A foundation preview, not a live HR system.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test('navigation exposes the scope and setup guidance', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Explore the build plan' }).click();
  await expect(
    page.getByRole('heading', { name: 'Built in deliberate steps.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Pakistan payroll' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Connection guide' }).click();
  await expect(
    page.getByRole('heading', { name: 'Connect the foundation.' }),
  ).toBeVisible();
  await expect(page.getByText('Access is intentionally closed.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to overview' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3000/');
});
test('shows a service outage and can retry successfully', async ({ page }) => {
  await page.route('**/api/v1/health/ready', (route) =>
    route.fulfill({ status: 503, body: '{}' }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(
    'Not connected · start the local services',
  );
  await page.unroute('**/api/v1/health/ready');
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Connected · runtime role verified',
  );
});
test('does not interpret an invalid health response as connected', async ({
  page,
}) => {
  await page.route('**/api/v1/health/ready', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"status":"ok","service":"wrong-service"}',
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(
    'Not connected · start the local services',
  );
});

test('account access explains administrator provisioning while sign-in is disabled', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Account access' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sign in to Kinto.' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Sign-in is not enabled in this environment yet.',
  );
  await expect(page.getByText(/There is no self-signup/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Continue to sign in' }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('account access handles outage, login and logout states without storing credentials', async ({
  page,
}) => {
  let signedIn = false;
  let unavailable = true;
  const csrf = 'a'.repeat(43);
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: unavailable ? 503 : signedIn ? 200 : 401,
      contentType: 'application/json',
      body: signedIn
        ? JSON.stringify({
            csrfToken: csrf,
            selectedTenantId: tenantId,
            tenants: [
              {
                id: tenantId,
                name: 'Synthetic Company',
                roles: ['owner'],
              },
            ],
          })
        : '{}',
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('status')).toHaveText(
    'Account access is unavailable. Please try again.',
  );
  unavailable = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('link', { name: 'Continue to sign in' }),
  ).toHaveAttribute('href', '/api/v1/auth/login');
  signedIn = true;
  await page.reload();
  await expect(page.getByRole('status')).toHaveText(
    'You are signed in to Synthetic Company.',
  );
  await page.route('**/api/v1/auth/logout', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe(csrf);
    signedIn = false;
    await route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Sign out of Kinto' }).click();
  await expect(
    page.getByRole('link', { name: 'Continue to sign in' }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('account access selects a company without browser-side session storage', async ({
  page,
}) => {
  let csrf = 'a'.repeat(43);
  const tenantA = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const tenantB = 'c223af99-e60b-4f4e-aad5-728b02e57d09';
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: null,
        tenants: [
          { id: tenantA, name: 'Alpha Company', roles: ['owner'] },
          { id: tenantB, name: 'Beta Company', roles: ['hr_admin'] },
        ],
      }),
    }),
  );
  await page.route('**/api/v1/auth/tenant', async (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers()['x-csrf-token']).toBe(csrf);
    expect(route.request().postDataJSON()).toEqual({ tenantId: tenantB });
    csrf = 'b'.repeat(43);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ selectedTenantId: tenantB, csrfToken: csrf }),
    });
  });
  await page.goto('/login');
  await expect(page.getByRole('status')).toHaveText(
    'You are signed in. Choose a company workspace.',
  );
  await page.getByRole('button', { name: /Beta Company/ }).click();
  await expect(page.getByRole('status')).toHaveText(
    'You are signed in to Beta Company.',
  );
  await expect(
    page.getByRole('button', { name: /Beta Company/ }),
  ).toBeDisabled();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
