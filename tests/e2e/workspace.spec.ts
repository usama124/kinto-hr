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
