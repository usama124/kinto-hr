import { expect, test, type Page } from '@playwright/test';
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
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
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

test('owner can review and paginate tenant security activity', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const actorId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const firstId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const secondId = '2415cafa-d6dc-45ae-8b50-4cd2d0035cdd';
  const cursor = 'a'.repeat(48);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: 'b'.repeat(43),
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/security-audit?*`,
    (route) => {
      const url = new URL(route.request().url());
      const isNext = url.searchParams.get('cursor') === cursor;
      const filtered = url.searchParams.get('action') === 'membership.revoked';
      const item = {
        id: isNext ? secondId : firstId,
        actorId,
        action: filtered
          ? 'membership.revoked'
          : isNext
            ? 'company.created'
            : 'membership.roles_changed',
        reason: filtered ? 'Access ended' : isNext ? null : 'Approved access',
        resourceId: tenantId,
        createdAt: isNext
          ? '2026-09-01T00:00:00.000Z'
          : '2026-09-02T00:00:00.000Z',
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [item],
          nextCursor: !isNext && !filtered ? cursor : null,
        }),
      });
    },
  );
  await page.goto('/security-audit');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  await expect(page.getByText('membership.roles changed')).toBeVisible();
  await page.getByRole('button', { name: 'Load more activity' }).click();
  await expect(page.getByText('company.created')).toBeVisible();
  await page.getByLabel('Action').fill('membership.revoked');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByText('membership.revoked')).toBeVisible();
  await expect(page.getByText('company.created')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('owner configures a legal employer, branch and published organization default', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const legalEntityId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const branchId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const departmentId = 'eb071d7d-89e8-493a-b5b7-3edaf41d4ae3';
  const designationId = '5fa15252-0934-4abe-8074-67b764424d65';
  const policyId = '2415cafa-d6dc-45ae-8b50-4cd2d0035cdd';
  const csrf = 'b'.repeat(43);
  const effectiveFrom = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const snapshot: {
    legalEntity: null | Record<string, unknown>;
    branches: Record<string, unknown>[];
    departments: Record<string, unknown>[];
    designations: Record<string, unknown>[];
    latestPublishedVersion: number;
    publishedPolicy: null | Record<string, unknown>;
    policyDrafts: Record<string, unknown>[];
  } = {
    legalEntity: null,
    branches: [],
    departments: [],
    designations: [],
    latestPublishedVersion: 0,
    publishedPolicy: null,
    policyDrafts: [],
  };

  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/organization**`,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const mutation =
        request.method() === 'POST' || request.method() === 'PUT';
      if (mutation) expect(request.headers()['x-csrf-token']).toBe(csrf);

      if (request.method() === 'GET' && path.endsWith('/organization')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot),
        });
      }
      if (request.method() === 'POST' && path.endsWith('/legal-entities')) {
        snapshot.legalEntity = {
          id: legalEntityId,
          legalName: 'Kinto Pakistan (Private) Limited',
          registrationNumber: null,
          taxNumber: null,
          countryCode: 'PK',
          currencyCode: 'PKR',
          timeZone: 'Asia/Karachi',
          provinceCode: 'PK-PB',
          version: 1,
        };
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: legalEntityId, version: 1 }),
        });
      }
      if (request.method() === 'POST' && path.endsWith('/branches')) {
        snapshot.branches = [
          {
            id: branchId,
            legalEntityId,
            code: 'LHR-01',
            name: 'Lahore Office',
            provinceCode: 'PK-PB',
            status: 'active',
            version: 1,
          },
        ];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: branchId, version: 1 }),
        });
      }
      if (request.method() === 'POST' && path.endsWith('/departments')) {
        snapshot.departments = [
          {
            id: departmentId,
            code: 'ENG',
            name: 'Engineering',
            status: 'active',
            version: 1,
          },
        ];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: departmentId, version: 1 }),
        });
      }
      if (request.method() === 'POST' && path.endsWith('/designations')) {
        snapshot.designations = [
          {
            id: designationId,
            code: 'SWE',
            name: 'Software Engineer',
            status: 'active',
            version: 1,
          },
        ];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: designationId, version: 1 }),
        });
      }
      if (request.method() === 'POST' && path.endsWith('/drafts')) {
        snapshot.policyDrafts = [
          {
            id: policyId,
            version: 1,
            basedOnVersion: 0,
            effectiveFrom,
            settings: { defaultBranchId: branchId },
            reason: 'Set initial company default',
          },
        ];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: policyId, version: 1 }),
        });
      }
      if (request.method() === 'GET' && path.endsWith('/preview')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: policyId,
            version: 1,
            basedOnVersion: 0,
            effectiveFrom,
            defaultBranch: {
              id: branchId,
              code: 'LHR-01',
              name: 'Lahore Office',
            },
            affectedOpenPeriods: [],
          }),
        });
      }
      if (request.method() === 'POST' && path.endsWith('/publication')) {
        snapshot.latestPublishedVersion = 1;
        snapshot.publishedPolicy = {
          id: policyId,
          version: 1,
          effectiveFrom,
          settings: { defaultBranchId: branchId },
        };
        snapshot.policyDrafts = [];
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: policyId, version: 1 }),
        });
      }
      return route.fulfill({ status: 404, body: '{}' });
    },
  );

  await page.goto('/organization');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  await expect(page.getByText('PK · PKR · Asia/Karachi')).toBeVisible();
  await page.getByLabel('Legal name').fill('Kinto Pakistan (Private) Limited');
  await page.getByLabel('Reason').first().fill('Create legal employer');
  await page.getByRole('button', { name: 'Create legal employer' }).click();
  await expect(
    page.getByRole('button', { name: 'Save legal employer' }),
  ).toBeVisible();

  const branchForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: 'Add branch' }),
  });
  await branchForm.getByLabel('Code').fill('LHR-01');
  await branchForm.getByLabel('Name', { exact: true }).fill('Lahore Office');
  await branchForm.getByLabel('Reason').fill('Create first branch');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(
    page.getByRole('listitem').getByText('LHR-01 · Lahore Office'),
  ).toBeVisible();

  const departmentForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: 'Add department' }),
  });
  await departmentForm.getByLabel('Code').fill('ENG');
  await departmentForm.getByLabel('Name').fill('Engineering');
  await departmentForm.getByLabel('Reason').fill('Create engineering');
  await departmentForm.getByRole('button', { name: 'Add department' }).click();
  await expect(page.getByText('ENG · Engineering')).toBeVisible();

  const designationForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: 'Add designation' }),
  });
  await designationForm.getByLabel('Code').fill('SWE');
  await designationForm.getByLabel('Name').fill('Software Engineer');
  await designationForm.getByLabel('Reason').fill('Create job title');
  await designationForm
    .getByRole('button', { name: 'Add designation' })
    .click();
  await expect(page.getByText('SWE · Software Engineer')).toBeVisible();

  await page.getByLabel('Effective from').fill(effectiveFrom);
  await page.getByLabel('Draft reason').fill('Set initial company default');
  await page.getByRole('button', { name: 'Create policy draft' }).click();
  await expect(page.getByText('Preview version 1')).toBeVisible();
  await page
    .getByLabel('Publication reason')
    .fill('Approve initial company default');
  await page.getByRole('button', { name: 'Publish policy' }).click();
  await expect(page.getByText('Current default branch:')).toContainText(
    'Lahore Office',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('employee reviews approved contact data and submits one strict change request', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const requestId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const csrf = 'b'.repeat(43);
  let requests: Record<string, unknown>[] = [];
  const submittedKeys: string[] = [];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['employee'] },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/me/profile`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        employee: {
          id: employeeId,
          employeeNumber: 'EMP-101',
          name: 'Sana Khan',
          legalName: null,
          status: 'active',
          joiningDate: '2026-09-01',
        },
        contact: {
          version: 1,
          personalEmail: 'sana@example.com',
          mobilePhone: '03001234567',
          emergencyContactName: 'Ali Khan',
          emergencyContactPhone: '03007654321',
        },
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/me/profile-change-requests`,
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ requests }),
        });
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      const idempotencyKey = route.request().headers()['idempotency-key'];
      expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      submittedKeys.push(idempotencyKey);
      expect(route.request().postDataJSON()).toEqual({
        expectedContactVersion: 1,
        personalEmail: 'sana.new@example.com',
        mobilePhone: '03001234567',
        emergencyContactName: 'Ali Khan',
        emergencyContactPhone: '03007654321',
        reason: 'Use my new personal email',
      });
      if (submittedKeys.length === 1)
        return route.fulfill({ status: 503, body: '{}' });
      requests = [
        {
          id: requestId,
          version: 1,
          status: 'pending',
          expectedContactVersion: 1,
          personalEmail: 'sana.new@example.com',
          mobilePhone: '03001234567',
          emergencyContactName: 'Ali Khan',
          emergencyContactPhone: '03007654321',
          reason: 'Use my new personal email',
          decisionReason: null,
          decidedAt: null,
          appliedContactVersion: null,
          createdAt: '2026-09-24T07:00:00.000Z',
        },
      ];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(requests[0]),
      });
    },
  );
  await page.goto('/profile-changes');
  await expect(
    page.getByRole('heading', { name: 'Your approved profile' }),
  ).toBeVisible();
  await expect(page.getByText('sana@example.com')).toBeVisible();
  await page.getByLabel('Personal email').fill('sana.new@example.com');
  await page.getByLabel('Reason').fill('Use my new personal email');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status')).toHaveText(
    /The request could not be submitted/,
  );
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Your contact change request is waiting for HR review.',
  );
  expect(submittedKeys).toHaveLength(2);
  expect(new Set(submittedKeys).size).toBe(1);
  await expect(page.getByText(/already waiting for review/)).toBeVisible();
  await expect(page.getByText('Use my new personal email')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

test('HR reviews and approves a pending contact proposal', async ({ page }) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const requestId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const csrf = 'b'.repeat(43);
  const pending = {
    id: requestId,
    version: 1,
    status: 'pending',
    expectedContactVersion: 1,
    personalEmail: 'sana.new@example.com',
    mobilePhone: '03001234567',
    emergencyContactName: 'Ali Khan',
    emergencyContactPhone: '03007654321',
    reason: 'Use my new personal email',
    decisionReason: null,
    decidedAt: null,
    appliedContactVersion: null,
    createdAt: '2026-09-24T07:00:00.000Z',
    employeeId,
    employeeNumber: 'EMP-101',
    employeeName: 'Sana Khan',
  };
  let requests: Record<string, unknown>[] = [pending];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['hr_admin'] },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/profile-change-requests**`,
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ requests }),
        });
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().headers()['idempotency-key']).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 1,
        decision: 'approved',
        reason: 'Verified directly with employee',
      });
      requests = [
        {
          ...pending,
          version: 2,
          status: 'approved',
          decisionReason: 'Verified directly with employee',
          decidedAt: '2026-09-24T07:30:00.000Z',
          appliedContactVersion: 2,
        },
      ];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(requests[0]),
      });
    },
  );
  await page.goto('/profile-changes');
  await expect(
    page.getByRole('heading', { name: 'HR review queue' }),
  ).toBeVisible();
  await expect(page.getByText('Sana Khan')).toBeVisible();
  await expect(page.getByText('sana.new@example.com')).toBeVisible();
  await page
    .getByLabel('Decision reason')
    .fill('Verified directly with employee');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('Request approved.');
  await expect(page.getByText('0 pending')).toBeVisible();
  await expect(page.getByText('Verified directly with employee')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('owner reviews the effective complimentary plan and employee capacity', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: 'b'.repeat(43),
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/entitlements`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: { code: 'business', version: 1 },
        billingMode: 'complimentary',
        employeeLimit: 100,
        activeEmployees: 32,
        availableEmployeeSeats: 68,
        capabilities: { companySetup: true },
        entitlementVersion: 1,
        effectiveFrom: '2026-09-08T00:00:00.000Z',
      }),
    }),
  );
  await page.goto('/entitlements');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'business' })).toBeVisible();
  await expect(page.getByText('Complimentary · no collection')).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'Employee capacity used' }),
  ).toHaveAttribute('aria-valuenow', '32');
  await expect(page.getByText('68 seats available')).toBeVisible();
  await expect(page.getByText(/have no production prices/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('HR validates and atomically commits a fixed employee CSV', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const batchId = 'dc8989e6-cffd-42f8-a44d-4903bab988f8';
  const csrf = 'b'.repeat(43);
  const content =
    'employee_number,display_name,legal_name,joining_date,branch_code,department_code,designation_code,manager_employee_number,top_level_reason\nEMP-001,Sana Khan,,2026-09-14,LHR-01,ENG,SWE,,Company leader\n';
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['hr_admin'] },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employee-imports`,
    async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().headers()['idempotency-key']).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(route.request().postDataJSON()).toEqual({
        fileName: 'employees.csv',
        content,
        reason: 'Preview initial employee import',
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: batchId,
          fileName: 'employees.csv',
          fileDigest: 'a'.repeat(64),
          previewRevision: 1,
          status: 'ready',
          rowCount: 1,
          errorCount: 0,
          fileErrors: [],
          rows: [
            {
              rowNumber: 2,
              values: {
                employeeNumber: 'EMP-001',
                name: 'Sana Khan',
                legalName: null,
                joiningDate: '2026-09-14',
                branchCode: 'LHR-01',
                departmentCode: 'ENG',
                designationCode: 'SWE',
                managerEmployeeNumber: null,
                topLevelReason: 'Company leader',
              },
              errors: [],
            },
          ],
          createdAt: '2026-09-14T12:00:00.000Z',
          committedAt: null,
          employees: [],
        }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employee-imports/${batchId}/confirm`,
    async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().headers()['idempotency-key']).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(route.request().postDataJSON()).toEqual({
        previewRevision: 1,
        fileDigest: 'a'.repeat(64),
        reason: 'Approve employee migration',
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: batchId,
          fileName: 'employees.csv',
          fileDigest: 'a'.repeat(64),
          previewRevision: 1,
          status: 'committed',
          rowCount: 1,
          errorCount: 0,
          fileErrors: [],
          rows: [
            {
              rowNumber: 2,
              values: {
                employeeNumber: 'EMP-001',
                name: 'Sana Khan',
                legalName: null,
                joiningDate: '2026-09-14',
                branchCode: 'LHR-01',
                departmentCode: 'ENG',
                designationCode: 'SWE',
                managerEmployeeNumber: null,
                topLevelReason: 'Company leader',
              },
              errors: [],
            },
          ],
          createdAt: '2026-09-14T12:00:00.000Z',
          committedAt: '2026-09-15T09:00:00.000Z',
          employees: [
            {
              rowNumber: 2,
              employeeId: '71dc8ea7-3ca0-42e7-b758-ff281923f902',
              employeeNumber: 'EMP-001',
              status: 'active',
              version: 2,
            },
          ],
        }),
      });
    },
  );
  await page.goto('/employee-imports');
  await page.getByLabel('Employee CSV').setInputFiles({
    name: 'employees.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(content),
  });
  await page
    .getByLabel('Preview reason')
    .fill('Preview initial employee import');
  await page.getByRole('button', { name: 'Upload and validate' }).click();
  await expect(page.getByText('Row 2 · EMP-001')).toBeVisible();
  await expect(
    page.getByText(/No employee records have been created/),
  ).toBeVisible();
  await expect(page.getByText(/SHA-256: a{64}/)).toBeVisible();
  await page
    .getByLabel('Confirmation reason')
    .fill('Approve employee migration');
  await page.getByRole('button', { name: 'Create 1 employees' }).click();
  await expect(page.getByText('Import committed')).toBeVisible();
  await expect(page.getByText(/1 active employees were created/)).toBeVisible();
});

test('HR creates, activates, separates, archives and rehires an employee', async ({
  page,
}) => {
  // Keep future termination fixtures independent of the real calendar date.
  await page.clock.setFixedTime(new Date('2026-09-20T09:00:00.000Z'));
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const branchId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const departmentId = 'eb071d7d-89e8-493a-b5b7-3edaf41d4ae3';
  const designationId = '5fa15252-0934-4abe-8074-67b764424d65';
  const assignmentId = '2415cafa-d6dc-45ae-8b50-4cd2d0035cdd';
  const checklistTaskId = 'c4f368b7-6690-47d4-98db-09defce41b8e';
  const csrf = 'b'.repeat(43);
  const joiningDate = '2026-09-08';
  const employees: Record<string, unknown>[] = [];
  let privateDetails: Record<string, unknown> | null = null;
  let bankDetails: Record<string, unknown> | null = null;
  let bankReads = 0;
  let bankWrites = 0;
  let compensation: Record<string, unknown> | null = null;
  const checklistTasks: Record<string, unknown>[] = [];
  const organization = {
    legalEntity: null,
    branches: [
      {
        id: branchId,
        legalEntityId: '50b6254c-e087-481b-8851-f0d3c5961d65',
        code: 'LHR-01',
        name: 'Lahore Office',
        provinceCode: 'PK-PB',
        status: 'active',
        version: 1,
      },
    ],
    departments: [
      {
        id: departmentId,
        code: 'ENG',
        name: 'Engineering',
        status: 'active',
        version: 1,
      },
    ],
    designations: [
      {
        id: designationId,
        code: 'SWE',
        name: 'Software Engineer',
        status: 'active',
        version: 1,
      },
    ],
    latestPublishedVersion: 0,
    publishedPolicy: null,
    policyDrafts: [],
  };
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        identityId: '18e19e63-bb7d-4b2d-87e8-2117f065951a',
        selectedTenantId: tenantId,
        tenants: [
          {
            id: tenantId,
            name: 'Synthetic Company',
            roles: ['hr_admin', 'payroll_preparer'],
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/organization`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(organization),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/checklist**`,
    async (route) => {
      const request = route.request();
      if (request.url().endsWith('/complete')) {
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        expect(request.postDataJSON()).toEqual({
          expectedVersion: 1,
          reason: 'Documents verified',
        });
        Object.assign(checklistTasks[0], {
          status: 'completed',
          version: 2,
          completedAt: '2026-09-14T12:00:00.000Z',
          completedByIdentityId: '18e19e63-bb7d-4b2d-87e8-2117f065951a',
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: checklistTaskId, version: 2 }),
        });
      }
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        expect(request.postDataJSON()).toMatchObject({
          lifecycle: 'onboarding',
          taskCode: 'COLLECT_DOCUMENTS',
          title: 'Collect signed documents',
          assigneeIdentityId: '18e19e63-bb7d-4b2d-87e8-2117f065951a',
          dueDate: '2026-09-10',
        });
        checklistTasks.push({
          id: checklistTaskId,
          employmentPeriodId: '3265216e-bcea-4d3f-854f-b728e9534531',
          lifecycle: 'onboarding',
          taskCode: 'COLLECT_DOCUMENTS',
          title: 'Collect signed documents',
          assigneeIdentityId: '18e19e63-bb7d-4b2d-87e8-2117f065951a',
          dueDate: '2026-09-10',
          status: 'pending',
          version: 1,
          completedAt: null,
          completedByIdentityId: null,
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: checklistTaskId, version: 1 }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: checklistTasks }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/compensation`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        expect(request.postDataJSON()).toMatchObject({
          expectedAgreementVersion: 0,
          effectiveFrom: joiningDate,
          components: [
            {
              code: 'BASIC',
              kind: 'basic_salary',
              monthlyAmount: '100000.00',
            },
          ],
          reason: 'Approved initial compensation',
        });
        compensation = {
          id: 'f2a1f960-463b-44ab-9495-44cbdbf1f946',
          employeeId,
          currencyCode: 'PKR',
          version: 1,
          revisions: [
            {
              revision: 1,
              effectiveFrom: joiningDate,
              effectiveTo: null,
              components: [
                {
                  code: 'BASIC',
                  name: 'Monthly basic salary',
                  kind: 'basic_salary',
                  monthlyAmount: '100000.00',
                },
              ],
              createdAt: '2026-09-14T00:00:00.000Z',
            },
          ],
        };
        Object.assign(employees[0], { payrollSetup: 'complete' });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: compensation.id, version: 1 }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agreement: compensation }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/bank-details`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        bankWrites++;
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        const input = request.postDataJSON();
        if (bankWrites === 3) return route.fulfill({ status: 409, body: '{}' });
        if (bankWrites === 4) return route.fulfill({ status: 403, body: '{}' });
        expect(input).toMatchObject({
          expectedVersion: bankWrites - 1,
          reason: bankWrites === 1 ? 'initial_setup' : 'clear_details',
        });
        if (bankWrites === 1) expect(input.accountNumber).toBe('00AB1234');
        else
          expect(input).toMatchObject({
            bankName: null,
            accountTitle: null,
            accountNumber: null,
          });
        bankDetails = {
          id: '2ca9fe8f-d494-4b3a-9940-c78873ea03d9',
          version: bankWrites,
          bankName: input.bankName,
          accountTitle: input.accountTitle,
          accountNumber: input.accountNumber,
          updatedAt: '2026-10-03T12:00:00.000Z',
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: bankDetails.id, version: bankWrites }),
        });
      }
      bankReads++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ details: bankDetails }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/private-details`,
    async (route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        const input = request.postDataJSON();
        expect(input).toMatchObject({
          expectedVersion: 0,
          personalEmail: 'sana@example.com',
          cnic: '35202-1234567-1',
          reason: 'Approved private employee details',
        });
        privateDetails = {
          id: '2ca9fe8f-d494-4b3a-9940-c78873ea03d9',
          version: 1,
          personalEmail: 'sana@example.com',
          mobilePhone: null,
          residentialAddress: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          cnic: '3520212345671',
          updatedAt: '2026-09-13T12:00:00.000Z',
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: privateDetails.id, version: 1 }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ details: privateDetails }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/activate`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 1,
        reason: 'Approved employee activation',
      });
      Object.assign(employees[0], { status: 'active', version: 2 });
      const history = employees[0].employmentHistory;
      if (!Array.isArray(history)) throw new Error('Missing period history');
      history[0] = { ...history[0], status: 'active' };
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: employeeId, version: 2, status: 'active' }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/terminate`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 2,
        finalWorkingDate: '2026-09-30',
        reason: 'Approved employee separation',
      });
      Object.assign(employees[0], {
        version: 3,
        finalWorkingDate: '2026-09-30',
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: employeeId, version: 3, status: 'active' }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/archive`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 4,
        reason: 'Approved historical employee archive',
      });
      Object.assign(employees[0], {
        status: 'archived',
        version: 5,
        archivedAt: '2026-10-01T00:00:00.000Z',
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: employeeId,
          version: 5,
          status: 'archived',
        }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/account/reactivation`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().postDataJSON()).toEqual({
        expectedMembershipVersion: 2,
        reason: 'Approved access restoration after rehire',
      });
      Object.assign(employees[0].accountAccess as Record<string, unknown>, {
        status: 'active',
        membershipVersion: 3,
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          membershipId: '8f8f15eb-374d-4569-a2ca-4ac9d7ce23a1',
          membershipVersion: 3,
          status: 'active',
        }),
      });
    },
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/rehire`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 5,
        joiningDate: '2026-10-02',
        branchId,
        departmentId,
        designationId,
        managerEmployeeId: null,
        topLevelReason: 'Approved returning top-level role',
        reason: 'Approved employee rehire',
      });
      const history = employees[0].employmentHistory;
      if (!Array.isArray(history)) throw new Error('Missing period history');
      Object.assign(employees[0], {
        status: 'active',
        version: 6,
        finalWorkingDate: null,
        employmentHistory: [
          {
            id: '9fca177d-3bd8-4f65-ad5f-a3708351df39',
            periodNumber: 2,
            joiningDate: '2026-10-02',
            finalWorkingDate: null,
            status: 'active',
          },
          ...history,
        ],
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: employeeId,
          version: 6,
          status: 'active',
        }),
      });
    },
  );
  await page.route(`**/api/v1/tenants/${tenantId}/employees`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      expect(request.postDataJSON()).toMatchObject({
        employeeNumber: 'EMP-001',
        name: 'Sana Khan',
        employmentType: 'monthly_salaried',
        managerEmployeeId: null,
        topLevelReason: 'Company chief executive',
      });
      employees.push({
        id: employeeId,
        employeeNumber: 'EMP-001',
        name: 'Sana Khan',
        legalName: null,
        status: 'draft',
        version: 1,
        joiningDate,
        employmentType: 'monthly_salaried',
        payrollSetup: 'incomplete',
        accountAccess: { status: 'active', membershipVersion: 1 },
        finalWorkingDate: null,
        archivedAt: null,
        employmentHistory: [
          {
            id: '3265216e-bcea-4d3f-854f-b728e9534531',
            periodNumber: 1,
            joiningDate,
            finalWorkingDate: null,
            status: 'planned',
          },
        ],
        currentAssignment: {
          id: assignmentId,
          effectiveFrom: joiningDate,
          effectiveTo: null,
          branch: { id: branchId, code: 'LHR-01', name: 'Lahore Office' },
          department: { id: departmentId, code: 'ENG', name: 'Engineering' },
          designation: {
            id: designationId,
            code: 'SWE',
            name: 'Software Engineer',
          },
          manager: null,
          topLevelReason: 'Company chief executive',
        },
        assignmentHistory: [
          {
            id: assignmentId,
            effectiveFrom: joiningDate,
            effectiveTo: null,
            branch: { id: branchId, code: 'LHR-01', name: 'Lahore Office' },
            department: { id: departmentId, code: 'ENG', name: 'Engineering' },
            designation: {
              id: designationId,
              code: 'SWE',
              name: 'Software Engineer',
            },
            manager: null,
            topLevelReason: 'Company chief executive',
          },
        ],
      });
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: employeeId, version: 1 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ employees }),
    });
  });
  await page.goto('/employees');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  await page.getByLabel('Employee number').fill('EMP-001');
  await page.getByLabel('Display name', { exact: true }).fill('Sana Khan');
  await page.getByLabel('Joining date').fill(joiningDate);
  await page
    .getByLabel('Top-level exception', { exact: true })
    .fill('Company chief executive');
  await page.getByLabel('Audit reason').fill('Create initial employee record');
  await page.getByRole('button', { name: 'Create employee draft' }).click();
  await expect(page.getByText('EMP-001 · Software Engineer')).toBeVisible();
  await expect(
    page.getByText(/Payroll setup remains incomplete/),
  ).toBeVisible();
  await expect(page.getByText(/Salary and bank details require/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Load onboarding/offboarding checklist' })
    .click();
  await page.getByLabel('Stable task code').fill('COLLECT_DOCUMENTS');
  await page.getByLabel('Task title').fill('Collect signed documents');
  await page.getByLabel('Due date').fill('2026-09-10');
  await page.getByLabel('Creation reason').fill('Prepare employee onboarding');
  await page
    .getByRole('button', { name: 'Create task assigned to me' })
    .click();
  await expect(
    page.getByText(/Collect signed documents.*pending/),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('Documents verified'));
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(
    page.getByText(/Collect signed documents.*completed/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load restricted details' }).click();
  await page.getByLabel('Personal email').fill('sana@example.com');
  await page.getByLabel('CNIC').fill('35202-1234567-1');
  await page
    .getByLabel('Change reason')
    .fill('Approved private employee details');
  await page.getByRole('button', { name: 'Save restricted details' }).click();
  await expect(
    page.getByText('Private employee details saved with an audit record.'),
  ).toBeVisible();
  expect(bankReads).toBe(0);
  await page
    .getByRole('button', { name: 'Load bank details', exact: true })
    .click();
  await expect(page.getByText('No bank details recorded.')).toBeVisible();
  await page.getByLabel('Bank name', { exact: true }).fill('Synthetic Bank');
  await page
    .getByLabel('Account title', { exact: true })
    .fill('Synthetic Account');
  await page
    .getByLabel('Account number or IBAN', { exact: true })
    .fill('00-1234');
  await page
    .getByRole('button', { name: 'Save bank details', exact: true })
    .click();
  await expect(page.getByText(/Supply all bank fields/)).toBeVisible();
  expect(bankWrites).toBe(0);
  await page
    .getByLabel('Account number or IBAN', { exact: true })
    .fill('00 ab 1234');
  await page
    .getByRole('button', { name: 'Save bank details', exact: true })
    .click();
  await expect(
    page.getByLabel('Account number or IBAN', { exact: true }),
  ).toHaveValue('00AB1234');
  await page.getByLabel('Bank change reason').selectOption('clear_details');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Save bank details', exact: true })
    .click();
  await expect(
    page.getByLabel('Account number or IBAN', { exact: true }),
  ).toHaveValue('');
  await page.getByLabel('Bank name', { exact: true }).fill('Changed Bank');
  await page
    .getByLabel('Account title', { exact: true })
    .fill('Changed Account');
  await page
    .getByLabel('Account number or IBAN', { exact: true })
    .fill('00112233');
  await page
    .getByRole('button', { name: 'Save bank details', exact: true })
    .click();
  await expect(page.getByText(/Bank details changed elsewhere/)).toBeVisible();
  await expect(
    page.getByLabel('Account number or IBAN', { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Load bank details', exact: true })
    .click();
  await page.getByLabel('Bank name', { exact: true }).fill('Changed Bank');
  await page
    .getByLabel('Account title', { exact: true })
    .fill('Changed Account');
  await page
    .getByLabel('Account number or IBAN', { exact: true })
    .fill('00112233');
  await page
    .getByRole('button', { name: 'Save bank details', exact: true })
    .click();
  await expect(
    page.getByText(/Bank details were not confirmed saved/),
  ).toBeVisible();
  await expect(
    page.getByLabel('Account number or IBAN', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Load compensation history' }).click();
  await page.getByLabel('Monthly amount (PKR)').fill('100000.00');
  await page.getByLabel('Effective from').fill(joiningDate);
  await page
    .getByLabel('Compensation change reason')
    .fill('Approved initial compensation');
  await page
    .getByRole('button', { name: 'Save compensation revision' })
    .click();
  await expect(
    page.getByText(
      'Compensation revision saved. Earlier rates remain unchanged.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Monthly basic salary: PKR 100000.00/),
  ).toBeVisible();
  await page
    .getByLabel('Activation reason for Sana Khan')
    .fill('Approved employee activation');
  await page.getByRole('button', { name: 'Activate employee' }).click();
  await expect(
    page.getByText('Employee activated and an employee seat was allocated.'),
  ).toBeVisible();
  await expect(page.getByText('active', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Activate employee' }),
  ).toHaveCount(0);
  await page.getByLabel('Final working date for Sana Khan').fill('2026-09-30');
  await page
    .getByLabel('Termination reason for Sana Khan')
    .fill('Approved employee separation');
  await page.getByRole('button', { name: 'Schedule termination' }).click();
  await expect(
    page.getByText(
      'Termination scheduled. Access remains active through the final working date.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Final working date: 2026-09-30. Access ends after this date.',
    ),
  ).toBeVisible();
  Object.assign(employees[0], {
    status: 'terminated',
    version: 4,
    accountAccess: { status: 'revoked', membershipVersion: 2 },
  });
  const history = employees[0].employmentHistory;
  if (!Array.isArray(history)) throw new Error('Missing period history');
  history[0] = {
    ...history[0],
    finalWorkingDate: '2026-09-30',
    status: 'ended',
  };
  await page.reload();
  await page
    .getByLabel('Archive reason for Sana Khan')
    .fill('Approved historical employee archive');
  await page.getByRole('button', { name: 'Archive employee' }).click();
  await expect(
    page.getByText('Employee archived. Employment history remains available.'),
  ).toBeVisible();
  await expect(page.getByText(/Employment history is retained/)).toBeVisible();
  await page.getByLabel('New joining date for Sana Khan').fill('2026-10-02');
  await page
    .getByLabel('Top-level reporting reason')
    .fill('Approved returning top-level role');
  await page.getByLabel('Rehire reason').fill('Approved employee rehire');
  await page.getByRole('button', { name: 'Rehire employee' }).click();
  await expect(
    page.getByText(
      'Employee rehired with a new employment period and allocated seat. Login access remains revoked.',
    ),
  ).toBeVisible();
  await page
    .getByLabel('Access restoration reason for Sana Khan')
    .fill('Approved access restoration after rehire');
  await page.getByRole('button', { name: 'Restore login access' }).click();
  await expect(
    page.getByText(
      'Employee login access restored to the existing verified account.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Login access: active')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Restore login access' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('HR reviews aggregate workforce movement and safely retries an audited export', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const departmentId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const exportId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const csrf = 'r'.repeat(43);
  const submittedKeys: string[] = [];
  let reportRequests = 0;

  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['hr_admin'] },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/reports/headcount**`,
    (route) => {
      reportRequests += 1;
      const url = new URL(route.request().url());
      const asOf = url.searchParams.get('asOf');
      const periodStart = url.searchParams.get('periodStart');
      const periodEnd = url.searchParams.get('periodEnd');
      expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          asOf,
          periodStart,
          periodEnd,
          headcount: 12,
          joiners: 3,
          leavers: 1,
          departments: [
            {
              departmentId,
              departmentCode: 'ENG',
              departmentName: 'Engineering',
              headcount: 9,
            },
          ],
          unassignedHeadcount: 3,
        }),
      });
    },
  );
  await page.route(`**/api/v1/tenants/${tenantId}/exports**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/exports')) {
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      const key = request.headers()['idempotency-key'];
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      submittedKeys.push(key);
      expect(request.postDataJSON()).toEqual({
        kind: 'workforce_headcount_csv',
        parameters: {
          asOf: '2026-09-29',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-29',
        },
        reason: 'Monthly workforce review',
      });
      if (submittedKeys.length === 1)
        return route.fulfill({ status: 503, body: '{}' });
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          id: exportId,
          kind: 'workforce_headcount_csv',
          status: 'pending',
          parameters: {
            asOf: '2026-09-29',
            periodStart: '2026-09-01',
            periodEnd: '2026-09-29',
          },
          createdAt: '2026-09-29T08:00:00.000Z',
          expiresAt: '2026-09-30T08:00:00.000Z',
        }),
      });
    }
    expect(request.method()).toBe('GET');
    expect(url.pathname).toBe(
      `/api/v1/tenants/${tenantId}/exports/${exportId}`,
    );
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: exportId,
        kind: 'workforce_headcount_csv',
        status: 'ready',
        parameters: {
          asOf: '2026-09-29',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-29',
        },
        createdAt: '2026-09-29T08:00:00.000Z',
        expiresAt: '2026-09-30T08:00:00.000Z',
      }),
    });
  });

  await page.goto('/reports');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  const totals = page.getByRole('region', { name: 'Workforce totals' });
  await expect(totals.getByText('12')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Engineering' })).toBeVisible();

  await page.getByLabel('Movement period start').fill('2025-01-01');
  await page.getByLabel('Movement period end').fill('2026-09-29');
  await page.getByRole('button', { name: 'Update report' }).click();
  await expect(page.getByRole('status')).toHaveText(/no more than 366 days/);
  expect(reportRequests).toBe(1);

  await page.getByLabel('Headcount as of').fill('2026-09-29');
  await page.getByLabel('Movement period start').fill('2026-09-01');
  await page.getByLabel('Movement period end').fill('2026-09-29');
  await page.getByRole('button', { name: 'Update report' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Workforce totals updated.',
  );
  expect(reportRequests).toBe(2);

  await page.getByRole('button', { name: 'Prepare CSV' }).click();
  await expect(page.getByRole('status')).toHaveText(
    /Retry to safely reuse the same request/,
  );
  await page.getByRole('button', { name: 'Prepare CSV' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Your aggregate CSV is ready to download.',
  );
  expect(submittedKeys).toHaveLength(2);
  expect(new Set(submittedKeys).size).toBe(1);
  await expect(
    page.getByRole('link', { name: 'Download aggregate CSV' }),
  ).toHaveAttribute(
    'href',
    `/api/v1/tenants/${tenantId}/exports/${exportId}/content`,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

test('employee role cannot open company workforce reports', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  let reportRequested = false;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: 'e'.repeat(43),
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['employee'] },
        ],
      }),
    }),
  );
  await page.route('**/api/v1/tenants/*/reports/headcount**', (route) => {
    reportRequested = true;
    return route.fulfill({ status: 500, body: '{}' });
  });

  await page.goto('/reports');
  await expect(page.getByRole('status')).toHaveText(
    'Only company owners and HR administrators can view workforce reports.',
  );
  expect(reportRequested).toBe(false);
});

test('HR registers, scans, activates, and downloads an employee document replacement', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const originalId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const replacementId = 'eb071d7d-89e8-493a-b5b7-3edaf41d4ae3';
  const csrf = 'b'.repeat(43);
  const bytes = Buffer.from('%PDF-1.7\n%%EOF');
  const employee = {
    id: employeeId,
    employeeNumber: 'EMP-001',
    name: 'Sana Khan',
    legalName: null,
    status: 'active',
    version: 2,
    joiningDate: '2026-09-08',
    employmentType: 'monthly_salaried',
    payrollSetup: 'complete',
    accountAccess: { status: 'active', membershipVersion: 1 },
    finalWorkingDate: null,
    archivedAt: null,
    employmentHistory: [
      {
        id: '2415cafa-d6dc-45ae-8b50-4cd2d0035cdd',
        periodNumber: 1,
        joiningDate: '2026-09-08',
        finalWorkingDate: null,
        status: 'active',
      },
    ],
    currentAssignment: null,
    assignmentHistory: [],
  };
  const original = {
    id: originalId,
    employeeId,
    category: 'employment',
    visibility: 'employee_visible',
    fileName: 'contract-2025.pdf',
    contentType: 'application/pdf',
    sizeBytes: bytes.length,
    status: 'clean',
    expiresOn: null,
    replacementDocumentId: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    scannedAt: '2026-09-01T09:01:00.000Z',
    removedAt: null,
    removalReason: null,
    removalReplacementDocumentId: null,
  };
  const documents: Record<string, unknown>[] = [original];
  let uploadAttempts = 0;

  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['hr_admin'] },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/employees`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ employees: [employee] }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/documents**`,
    async (route) => {
      const request = route.request();
      const url = request.url();
      if (url.endsWith(`/${replacementId}/content`)) {
        if (request.method() === 'PUT') {
          expect(request.headers()['x-csrf-token']).toBe(csrf);
          expect(request.postDataBuffer()).toEqual(bytes);
          uploadAttempts += 1;
          if (uploadAttempts === 1)
            return route.fulfill({ status: 503, body: '{}' });
          Object.assign(documents[1], {
            status: 'clean',
            scannedAt: '2026-09-30T09:01:00.000Z',
          });
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(documents[1]),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          body: bytes,
        });
      }
      if (url.endsWith(`/${replacementId}/replacement-activation`)) {
        expect(request.method()).toBe('POST');
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        expect(request.postDataJSON()).toEqual({
          reason: 'Approved signed contract replacement',
        });
        Object.assign(documents[0], {
          status: 'removed',
          removedAt: '2026-09-30T09:02:00.000Z',
          removalReason: 'Approved signed contract replacement',
          removalReplacementDocumentId: replacementId,
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            replacement: documents[1],
            retiredDocument: documents[0],
          }),
        });
      }
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe(csrf);
        expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(request.postDataJSON()).toMatchObject({
          category: 'employment',
          visibility: 'employee_visible',
          fileName: 'contract-2026.pdf',
          contentType: 'application/pdf',
          sizeBytes: bytes.length,
          fileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresOn: null,
          replacementDocumentId: originalId,
          reason: 'Register signed contract replacement',
        });
        documents.push({
          ...original,
          id: replacementId,
          fileName: 'contract-2026.pdf',
          status: 'awaiting_upload',
          replacementDocumentId: originalId,
          createdAt: '2026-09-30T09:00:00.000Z',
          scannedAt: null,
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(documents[1]),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documents }),
      });
    },
  );

  await page.goto('/documents');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  await expect(
    page.getByText('contract-2025.pdf', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('File').setInputFiles({
    name: 'contract-2026.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await page.getByLabel('Visibility').selectOption('employee_visible');
  await page
    .getByLabel('Replaces document (optional)')
    .selectOption(originalId);
  await page
    .getByLabel('Registration reason')
    .fill('Register signed contract replacement');
  await page.getByRole('button', { name: 'Register and upload' }).click();
  await expect(page.getByRole('status')).toHaveText(
    /Metadata was saved, but upload or malware scanning is unavailable/,
  );
  await page.reload();
  await page.getByLabel('Exact registered file').setInputFiles({
    name: 'contract-2026.pdf',
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await page.getByRole('button', { name: 'Upload and scan' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Document uploaded and malware scanning completed.',
  );
  await expect(page.getByText('Awaiting activation')).toBeVisible();
  await page
    .getByLabel('Activation reason')
    .fill('Approved signed contract replacement');
  await page.getByRole('button', { name: 'Activate replacement' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Replacement activated. The superseded document is retired.',
  );
  await expect(
    page.getByText('Approved signed contract replacement'),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  await download;
  await expect(page.getByRole('status')).toHaveText(
    'Authorized document download started.',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('employee role cannot open the company document manager', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  let rosterRequests = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: 'b'.repeat(43),
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['employee'] },
        ],
      }),
    }),
  );
  await page.route('**/api/v1/tenants/*/employees', (route) => {
    rosterRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"employees":[]}',
    });
  });
  await page.goto('/documents');
  await expect(page.getByRole('main')).toHaveText(
    'Only company owners and HR administrators can manage documents.',
  );
  expect(rosterRequests).toBe(0);
});

test('employee shared documents download and handle revoked access', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const documentId = 'c49ece51-c534-45c7-845e-643f8e010658';
  let contentStatus = 200;
  let hrRequests = 0;
  await page.route('**/api/v1/tenants/*/employees**', (route) => {
    hrRequests += 1;
    return route.fulfill({ status: 403 });
  });
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['employee'] },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/me/documents`, (route) =>
    route.fulfill({
      json: {
        documents: [
          {
            id: documentId,
            employeeId: 'd00fdc0d-7773-4a45-ae0d-99a43b072401',
            category: 'employment',
            visibility: 'employee_visible',
            fileName: 'shared-contract.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10,
            status: 'clean',
            expiresOn: null,
            replacementDocumentId: null,
            createdAt: '2026-09-01T09:00:00.000Z',
            scannedAt: '2026-09-01T09:01:00.000Z',
            removedAt: null,
            removalReason: null,
            removalReplacementDocumentId: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/me/documents/${documentId}/content`,
    (route) =>
      route.fulfill({
        status: contentStatus,
        contentType: 'application/pdf',
        body: '%PDF-test',
      }),
  );
  await page.goto('/my-documents');
  await expect(
    page.getByRole('heading', { name: 'My documents' }),
  ).toBeVisible();
  const button = page.getByRole('button', {
    name: 'Download shared-contract.pdf',
  });
  const download = page.waitForEvent('download');
  await button.click();
  expect((await download).suggestedFilename()).toBe(
    `document-${documentId}.pdf`,
  );
  await expect(page.getByRole('status')).toHaveText(
    'Authorized document download started.',
  );
  contentStatus = 503;
  await button.click();
  await expect(page.getByRole('status')).toHaveText(/storage is unavailable/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  contentStatus = 403;
  await button.click();
  await expect(page.getByRole('main')).toHaveText(
    /Employee document access is unavailable/,
  );
  await expect(
    page.getByText('shared-contract.pdf', { exact: true }),
  ).toHaveCount(0);
  expect(hrRequests).toBe(0);
});

test('employee documents handle empty, invalid, unavailable and session states', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  let sessionStatus = 200;
  let selectedTenantId: string | null = tenantId;
  let roles = ['employee'];
  let listStatus = 200;
  let listBody: unknown = { documents: [] };
  let listRequests = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: sessionStatus,
      json: {
        selectedTenantId,
        tenants: [{ id: tenantId, name: 'Synthetic Company', roles }],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/me/documents`, (route) => {
    listRequests += 1;
    return route.fulfill({ status: listStatus, json: listBody });
  });
  await page.goto('/my-documents');
  await expect(
    page.getByText('No documents have been shared with you.'),
  ).toBeVisible();
  listBody = { documents: [{ fileName: 'invalid-private.pdf' }] };
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Your documents are unavailable. Refresh and try again.',
  );
  await expect(page.getByText('invalid-private.pdf')).toHaveCount(0);
  listStatus = 503;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Your documents are unavailable. Refresh and try again.',
  );
  listStatus = 403;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    /Employee document access is unavailable/,
  );
  const priorRequests = listRequests;
  roles = ['hr_admin'];
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    /Employee document access is unavailable/,
  );
  selectedTenantId = null;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Choose a company workspace to view your documents.',
  );
  sessionStatus = 401;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Sign in to view your documents.',
  );
  expect(listRequests).toBe(priorRequests);
});

test('owner manages administrative roles and revokes access without employee controls', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const adminId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const employeeId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const csrf = 'b'.repeat(43);
  const member = {
    id: adminId,
    identityId: adminId,
    status: 'active',
    roles: ['hr_admin'],
    version: 1,
    employeeId: null,
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  const employee = {
    ...member,
    id: employeeId,
    identityId: employeeId,
    roles: ['employee'],
    employeeId,
  };
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/memberships`, (route) =>
    route.fulfill({ json: { memberships: [member, employee] } }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/memberships/${adminId}/*`,
    (route) => {
      const request = route.request();
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      if (request.url().endsWith('/roles')) {
        expect(request.method()).toBe('PUT');
        expect(request.postDataJSON()).toEqual({
          expectedVersion: 1,
          roles: ['hr_admin', 'payroll_preparer'],
          reason: 'Approved payroll responsibilities',
        });
        member.roles = ['hr_admin', 'payroll_preparer'];
        member.version = 2;
      } else {
        expect(request.method()).toBe('POST');
        expect(request.postDataJSON()).toEqual({
          expectedVersion: 2,
          reason: 'Approved access revocation',
        });
        member.status = 'revoked';
        member.version = 3;
      }
      return route.fulfill({
        json: {
          id: member.id,
          status: member.status,
          roles: member.roles,
          version: member.version,
        },
      });
    },
  );
  await page.goto('/members');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Company' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Manage membership ${employeeId}` }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Employee access: use employee lifecycle controls.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: `Manage membership ${adminId}` })
    .click();
  await expect(page.getByRole('button', { name: 'Save roles' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'payroll preparer' }).check();
  await page
    .getByLabel('Audit reason', { exact: true })
    .fill('Approved payroll responsibilities');
  await page.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Administrative roles updated with an audit record.',
  );
  await page
    .getByRole('button', { name: `Manage membership ${adminId}` })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'payroll preparer' }),
  ).toBeChecked();
  await page
    .getByLabel('Audit reason', { exact: true })
    .fill('Approved access revocation');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Revoke administrative access' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Edit administrative access' }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Revoke administrative access' })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    'Administrative access revoked with an audit record.',
  );
  await expect(
    page.getByRole('button', { name: `Manage membership ${adminId}` }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Revoked access is retained for audit history.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('membership conflicts refresh versions and uncertain mutations require refresh', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const memberId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const member = {
    id: memberId,
    identityId: memberId,
    status: 'active',
    roles: ['owner'],
    version: 1,
    employeeId: null,
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  let mutationStatus = 409;
  let expectedVersion = 1;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        csrfToken: 'b'.repeat(43),
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/memberships`, (route) =>
    route.fulfill({ json: { memberships: [member] } }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/memberships/${memberId}/roles`,
    (route) => {
      expect(route.request().postDataJSON().expectedVersion).toBe(
        expectedVersion,
      );
      member.version += 1;
      return route.fulfill({ status: mutationStatus, json: {} });
    },
  );
  await page.goto('/members');
  const manage = page.getByRole('button', {
    name: `Manage membership ${memberId}`,
  });
  async function attempt() {
    await manage.click();
    await page.getByRole('checkbox', { name: 'hr admin' }).check();
    await page
      .getByLabel('Audit reason', { exact: true })
      .fill('Approved administrative change');
    await page.getByRole('button', { name: 'Save roles' }).click();
  }
  await attempt();
  await expect(page.getByRole('status')).toHaveText(
    /Change refused.*last active owner/,
  );
  mutationStatus = 503;
  expectedVersion = 2;
  await attempt();
  await expect(page.getByRole('status')).toHaveText(
    /Refresh memberships before trying again/,
  );
  await expect(manage).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh memberships' }).click();
  await expect(manage).toBeEnabled();
  mutationStatus = 403;
  expectedVersion = 3;
  await attempt();
  await expect(page.getByRole('main')).toHaveText(
    /Only a company owner with recent verification/,
  );
  await expect(manage).toHaveCount(0);
});

test('membership workspace rejects non-owner sessions and invalid projections', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  let roles = ['hr_admin'];
  let selectedTenantId: string | null = tenantId;
  let sessionStatus = 200;
  let listStatus = 200;
  let list: unknown = { memberships: [] };
  let reads = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: sessionStatus,
      json: {
        csrfToken: 'b'.repeat(43),
        selectedTenantId,
        tenants: [{ id: tenantId, name: 'Synthetic Company', roles }],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/memberships`, (route) => {
    reads += 1;
    return route.fulfill({ status: listStatus, json: list });
  });
  for (const deniedRoles of [
    ['hr_admin'],
    ['employee'],
    ['payroll_preparer'],
    ['payroll_approver'],
  ]) {
    roles = deniedRoles;
    await page.goto('/members');
    await expect(page.getByRole('main')).toHaveText(
      /Only a company owner with recent verification/,
    );
  }
  expect(reads).toBe(0);
  selectedTenantId = null;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Choose a company workspace before managing access.',
  );
  sessionStatus = 401;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Sign in to manage company access.',
  );
  sessionStatus = 200;
  roles = ['owner'];
  selectedTenantId = tenantId;
  await page.reload();
  await expect(page.getByText('No memberships are available.')).toBeVisible();
  list = { memberships: [{ email: 'private@example.com' }] };
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Membership administration is unavailable. Refresh and try again.',
  );
  await expect(page.getByText('private@example.com')).toHaveCount(0);
  listStatus = 403;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    /Only a company owner with recent verification/,
  );
});

test('owner retries an exact administrator invitation through uncertain delivery and activation', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const requestId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const csrf = 'b'.repeat(43);
  let attempt = 0;
  let originalKey = '';
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        csrfToken: csrf,
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/memberships`, (route) =>
    route.fulfill({
      json: {
        memberships: [
          {
            id: requestId,
            identityId: requestId,
            roles: ['owner'],
            status: 'active',
            employeeId: null,
            version: 1,
            createdAt: '2026-10-01T09:00:00.000Z',
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/administrator-invitations`,
    (route) => {
      const request = route.request();
      expect(request.method()).toBe('POST');
      expect(request.headers()['x-csrf-token']).toBe(csrf);
      expect(request.postDataJSON()).toEqual({
        email: 'admin@example.com',
        roles: ['hr_admin', 'payroll_approver'],
        reason: 'Approved administrator setup',
      });
      const key = request.headers()['idempotency-key'];
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      attempt += 1;
      if (attempt === 1) {
        originalKey = key;
        return route.fulfill({ status: 503, json: {} });
      }
      expect(key).toBe(originalKey);
      return route.fulfill({
        status: 202,
        json: {
          accountRequestId: requestId,
          status:
            attempt === 2
              ? 'pending_identity_provider'
              : attempt === 3
                ? 'pending_delivery'
                : 'pending_activation',
          replayed: true,
        },
      });
    },
  );
  await page.goto('/members');
  await page
    .getByRole('button', { name: 'Invite administrator', exact: true })
    .click();
  const form = page.getByRole('region', { name: 'Administrator invitation' });
  await form.getByLabel('Administrator email').fill('Admin@Example.COM');
  await form.getByRole('checkbox', { name: 'payroll approver' }).check();
  await form.getByRole('checkbox', { name: 'hr admin' }).check();
  await expect(
    form.getByRole('checkbox', { name: 'employee', exact: true }),
  ).toHaveCount(0);
  await form
    .getByLabel('Invitation reason')
    .fill('Approved administrator setup');
  await form
    .getByRole('button', { name: 'Submit administrator invitation' })
    .click();
  await expect(form.getByRole('status')).toHaveText(
    /outcome could not be confirmed/,
  );
  await expect(form.getByLabel('Administrator email')).toBeDisabled();
  // Editing existing membership must not unmount and lose the pending invitation.
  await page
    .getByRole('button', { name: `Manage membership ${requestId}` })
    .click();
  await expect(
    form.getByRole('button', { name: 'Retry same invitation' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel editing' }).click();
  await form.getByRole('button', { name: 'Retry same invitation' }).click();
  await expect(form.getByRole('status')).toHaveText(
    /Request recorded.*No access is granted/,
  );
  await expect(form.getByText(/Existing request replayed/)).toBeVisible();
  await form.getByRole('button', { name: 'Retry same invitation' }).click();
  await expect(form.getByRole('status')).toHaveText(
    /Delivery is pending.*No access is granted/,
  );
  await form.getByRole('button', { name: 'Retry same invitation' }).click();
  await expect(form.getByRole('status')).toHaveText(
    /Access stays pending.*verified activation/,
  );
  await expect(
    form.getByRole('button', { name: 'Retry same invitation' }),
  ).toHaveCount(0);
  expect(attempt).toBe(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await form.getByRole('button', { name: 'New invitation' }).click();
  await expect(form.getByLabel('Administrator email')).toHaveValue('');
  await expect(
    form.getByRole('checkbox', { name: 'hr admin' }),
  ).not.toBeChecked();
});

test('administrator invitation handles conflicts, malformed replies and lost authority', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  let attempt = 0;
  const keys: string[] = [];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        csrfToken: 'b'.repeat(43),
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['owner'] },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/memberships`, (route) =>
    route.fulfill({ json: { memberships: [] } }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/administrator-invitations`,
    (route) => {
      keys.push(route.request().headers()['idempotency-key']);
      attempt += 1;
      if (attempt === 1) return route.fulfill({ status: 409, json: {} });
      if (attempt === 2)
        return route.fulfill({
          status: 202,
          json: { status: 'made_up', email: 'private@example.com' },
        });
      return route.fulfill({ status: 403, json: {} });
    },
  );
  await page.goto('/members');
  await page
    .getByRole('button', { name: 'Invite administrator', exact: true })
    .click();
  const form = page.getByRole('region', { name: 'Administrator invitation' });
  await expect(
    form.getByRole('button', { name: 'Submit administrator invitation' }),
  ).toBeDisabled();
  await form.getByLabel('Administrator email').fill('admin@example.com');
  await form.getByRole('checkbox', { name: 'owner', exact: true }).check();
  await form.getByLabel('Invitation reason').fill('Approved additional owner');
  await form
    .getByRole('button', { name: 'Submit administrator invitation' })
    .click();
  await expect(form.getByRole('status')).toHaveText(/Invitation refused/);
  await expect(form.getByLabel('Administrator email')).toBeEnabled();
  await form.getByLabel('Administrator email').fill('another@example.com');
  await form
    .getByRole('button', { name: 'Submit administrator invitation' })
    .click();
  await expect(form.getByRole('status')).toHaveText(
    /outcome could not be confirmed/,
  );
  expect(keys[1]).not.toBe(keys[0]);
  await expect(
    page.getByText('private@example.com', { exact: true }),
  ).toHaveCount(0);
  await form.getByRole('button', { name: 'Retry same invitation' }).click();
  expect(keys[2]).toBe(keys[1]);
  await expect(page.getByRole('main')).toHaveText(
    /Only a company owner with recent verification/,
  );
  await expect(
    page.getByRole('region', { name: 'Administrator invitation' }),
  ).toHaveCount(0);
});

test('platform operator creates a complimentary company with exact safe retries', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const requestId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  let attempts = 0;
  let key = '';
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: { csrfToken: 'b'.repeat(43), selectedTenantId: null, tenants: [] },
    }),
  );
  await page.route('**/api/v1/platform/access', (route) =>
    route.fulfill({ json: { canProvisionCompany: true } }),
  );
  await page.route('**/api/v1/platform/tenants', (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe('b'.repeat(43));
    expect(request.postDataJSON()).toEqual({
      companyName: 'Synthetic Company',
      initialOwnerEmail: 'owner@example.com',
      employeeLimit: 50,
      billingMode: 'complimentary',
    });
    attempts += 1;
    const currentKey = request.headers()['idempotency-key'];
    expect(currentKey).toMatch(/^[0-9a-f-]{36}$/);
    if (attempts === 1) {
      key = currentKey;
      return route.fulfill({ status: 503, json: {} });
    }
    expect(currentKey).toBe(key);
    return route.fulfill({
      status: 202,
      json: {
        tenantId,
        provisioningRequestId: requestId,
        status:
          attempts === 2 ? 'pending_identity_provider' : 'pending_activation',
        replayed: true,
      },
    });
  });
  await page.goto('/platform/companies');
  await expect(
    page.getByRole('heading', { name: 'Create company account' }),
  ).toBeVisible();
  await expect(page.getByLabel('Employee package')).toBeDisabled();
  await page
    .getByLabel('Company name', { exact: true })
    .fill(' Synthetic Company ');
  await page.getByLabel('Initial owner email').fill('Owner@Example.COM');
  await page.getByLabel('Access model').selectOption('complimentary');
  await page.getByLabel('Employee package').selectOption('50');
  await page
    .getByRole('button', { name: 'Create company', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(/could not be confirmed/);
  await expect(page.getByLabel('Company name', { exact: true })).toBeDisabled();
  await page
    .getByRole('button', { name: 'Retry same company request' })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    /Company recorded.*No owner access is granted/,
  );
  await page
    .getByRole('button', { name: 'Retry same company request' })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    /Access remains pending until verified activation/,
  );
  await expect(page.getByText(/Existing request replayed/)).toBeVisible();
  expect(attempts).toBe(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Create another company' }).click();
  await expect(page.getByLabel('Company name', { exact: true })).toHaveValue(
    '',
  );
  await expect(page.getByLabel('Access model')).toHaveValue('free');
});

test('company onboarding denies nonoperators and handles conflicts and malformed replies', async ({
  page,
}) => {
  let accessStatus = 403;
  let accessBody: unknown = { canProvisionCompany: true };
  let attempts = 0;
  const keys: string[] = [];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: { csrfToken: 'b'.repeat(43), selectedTenantId: null, tenants: [] },
    }),
  );
  await page.route('**/api/v1/platform/access', (route) =>
    route.fulfill({ status: accessStatus, json: accessBody }),
  );
  await page.route('**/api/v1/platform/tenants', (route) => {
    attempts += 1;
    keys.push(route.request().headers()['idempotency-key']);
    expect(route.request().postDataJSON()).toMatchObject({
      employeeLimit: 5,
      billingMode: 'free',
    });
    return route.fulfill({
      status: attempts === 1 ? 409 : attempts === 2 ? 202 : 401,
      json:
        attempts === 2
          ? { status: 'unknown', initialOwnerEmail: 'hidden@example.com' }
          : {},
    });
  });
  await page.goto('/platform/companies');
  await expect(page.getByRole('main')).toHaveText(
    /Only an active platform operator/,
  );
  await expect(
    page.getByRole('button', { name: 'Create company', exact: true }),
  ).toHaveCount(0);
  expect(attempts).toBe(0);
  accessStatus = 200;
  accessBody = { canProvisionCompany: true, providerSecret: 'invalid' };
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Platform access is unavailable. Refresh and try again.',
  );
  accessBody = { canProvisionCompany: true };
  await page.reload();
  await page
    .getByLabel('Company name', { exact: true })
    .fill('Synthetic Free Company');
  await page.getByLabel('Initial owner email').fill('owner@example.com');
  await page.getByLabel('Access model').selectOption('manual_paid');
  await page.getByLabel('Employee package').selectOption('100');
  await page.getByLabel('Access model').selectOption('free');
  await expect(page.getByLabel('Employee package')).toHaveValue('5');
  await page
    .getByRole('button', { name: 'Create company', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(/Company creation refused/);
  await page
    .getByRole('button', { name: 'Create company', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(/could not be confirmed/);
  expect(keys[1]).not.toBe(keys[0]);
  await expect(page.getByText('hidden@example.com')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Retry same company request' })
    .click();
  expect(keys[2]).toBe(keys[1]);
  await expect(page.getByRole('main')).toHaveText(
    'Sign in to create a company account.',
  );
});

test('platform company directory paginates, filters and removes results after access loss', async ({
  page,
}) => {
  const firstId = '00000000-0000-4000-8000-000000000001';
  const secondId = '00000000-0000-4000-8000-000000000002';
  let denied = false;
  const first = {
    id: firstId,
    name: 'Synthetic Alpha',
    status: 'active',
    createdAt: '2026-10-01T09:00:00.000Z',
    ownerSetupStatus: 'pending_activation',
    baseSubscription: {
      plan: 'growth',
      planVersion: 1,
      billingMode: 'complimentary',
      employeeLimit: 50,
    },
  };
  const second = {
    ...first,
    id: secondId,
    name: 'Synthetic Beta',
    status: 'suspended',
    ownerSetupStatus: null,
    baseSubscription: null,
  };
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { selectedTenantId: null, tenants: [] } }),
  );
  await page.route('**/api/v1/platform/tenants?**', (route) => {
    if (denied) return route.fulfill({ status: 403, json: {} });
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('limit')).toBe('25');
    if (query.get('search') === 'No match')
      return route.fulfill({ json: { companies: [], nextCursor: null } });
    return route.fulfill({
      json: {
        companies: [query.has('after') ? second : first],
        nextCursor: query.has('after') ? null : firstId,
      },
    });
  });
  await page.goto('/platform');
  await expect(
    page.getByText('Synthetic Alpha', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Base plan: growth v1.*50 employees.*complimentary/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Synthetic Beta', { exact: true })).toBeVisible();
  await expect(page.getByText('No current base subscription')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(
    page.getByText('Synthetic Alpha', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Company name filter').fill('No match');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByText('No companies match this filter.')).toBeVisible();
  await page.getByLabel('Company name filter').fill('');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(
    page.getByText('Synthetic Alpha', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  denied = true;
  await page.getByRole('button', { name: 'Refresh companies' }).click();
  await expect(page.getByRole('main')).toHaveText(
    /Only an active platform operator/,
  );
  await expect(page.getByText('Synthetic Alpha', { exact: true })).toHaveCount(
    0,
  );
});

test('platform directory fails closed for malformed metadata and signed-out sessions', async ({
  page,
}) => {
  let status = 200;
  let reads = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status, json: {} }),
  );
  await page.route('**/api/v1/platform/tenants?**', (route) => {
    reads += 1;
    return route.fulfill({
      json: {
        companies: [{ name: 'Private metadata', email: 'private@example.com' }],
        nextCursor: null,
      },
    });
  });
  await page.goto('/platform');
  await expect(page.getByRole('main')).toHaveText(
    'Company directory is unavailable. Refresh and try again.',
  );
  await expect(page.getByText('private@example.com')).toHaveCount(0);
  status = 401;
  await page.reload();
  await expect(page.getByRole('main')).toHaveText(
    'Sign in to review platform companies.',
  );
  expect(reads).toBe(1);
});

function operatorEntitlementFixture(tenantId: string) {
  return {
    tenantId,
    companyName: 'Synthetic Controlled Company',
    evaluatedAt: '2026-10-01T09:00:00.000Z',
    historyTruncated: false,
    effective: {
      plan: { code: 'free', version: 1 },
      billingMode: 'free',
      employeeLimit: 5,
      activeEmployees: 0,
      availableEmployeeSeats: 5,
      capabilities: { companySetup: true },
      entitlementVersion: 1,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    },
    controls: [] as Record<string, unknown>[],
  };
}
test('operator previews, applies and revokes a dated capacity control', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const controlId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const fixture = operatorEntitlementFixture(tenantId);
  const before = structuredClone(fixture.effective);
  let denied = false;
  let previews = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: { csrfToken: 'b'.repeat(43), selectedTenantId: null, tenants: [] },
    }),
  );
  await page.route(
    `**/api/v1/platform/tenants/${tenantId}/entitlements`,
    (route) => route.fulfill({ status: denied ? 403 : 200, json: fixture }),
  );
  await page.route(
    `**/api/v1/platform/tenants/${tenantId}/entitlement-changes**`,
    (route) => {
      const request = route.request();
      expect(request.headers()['x-csrf-token']).toBe('b'.repeat(43));
      const input = request.postDataJSON();
      if (request.url().endsWith('/preview')) {
        previews++;
        return route.fulfill({
          json: {
            at: input.startsAt,
            before,
            after: {
              ...before,
              employeeLimit: 5 + input.seatDelta,
              availableEmployeeSeats: 5 + input.seatDelta,
              entitlementVersion: 2,
            },
            changes: { employeeLimit: true, billingMode: false },
          },
        });
      }
      if (request.url().endsWith('/revocation')) {
        expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(input).toEqual({
          expectedVersion: 1,
          reason: 'Approved grant cancellation',
        });
        expect(request.url()).toContain(`/grant/${controlId}/revocation`);
        Object.assign(fixture.controls[0], {
          status: 'revoked',
          version: 2,
          revokedReason: input.reason,
        });
        fixture.effective = { ...before, entitlementVersion: 3 };
      } else {
        expect(input).toEqual({
          changeType: 'capacity_addon',
          seatDelta: 6,
          startsAt: '2026-12-01T09:00:00+05:00',
          endsAt: '2027-01-01T09:00:00+05:00',
          reason: 'Approved temporary seats',
        });
        fixture.controls.push({
          id: controlId,
          kind: 'grant',
          ...input,
          employeeLimit: null,
          status: 'active',
          version: 1,
          revokedReason: null,
        });
        fixture.effective = {
          ...before,
          employeeLimit: 11,
          availableEmployeeSeats: 11,
          entitlementVersion: 2,
        };
      }
      return route.fulfill({
        status: 200,
        json: {
          id: controlId,
          version: fixture.controls[0].version,
          entitlementVersion: fixture.effective.entitlementVersion,
        },
      });
    },
  );
  await page.goto(`/platform/companies/${tenantId}/entitlements`);
  await expect(
    page.getByRole('heading', { name: 'Synthetic Controlled Company' }),
  ).toBeVisible();
  await page.getByLabel('Starts at').fill('2026-12-01T09:00:00+05:00');
  await page.getByLabel('Ends at').fill('2027-01-01T09:00:00+05:00');
  await page.getByLabel('Control reason').fill('Approved temporary seats');
  await page.getByRole('button', { name: 'Preview control' }).click();
  await expect(
    page.getByRole('button', { name: 'Apply previewed control' }),
  ).toBeVisible();
  await page.getByLabel('Capacity value').fill('6');
  await expect(
    page.getByRole('button', { name: 'Apply previewed control' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview control' }).click();
  await page.getByRole('button', { name: 'Apply previewed control' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Entitlement control created with audit evidence.',
  );
  expect(previews).toBe(2);
  await expect(page.getByText(/version 1 · scheduled/)).toBeVisible();
  await page
    .getByLabel(`Revocation reason ${controlId}`)
    .fill('Approved grant cancellation');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: `Revoke control ${controlId}` })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    'Control revoked with audit evidence.',
  );
  await expect(
    page.getByText('Revocation: Approved grant cancellation'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  denied = true;
  await page
    .getByRole('button', { name: 'Refresh entitlement history' })
    .click();
  await expect(page.getByRole('main')).toHaveText(
    /Only an active platform operator/,
  );
});

test('operator entitlement uncertainty preserves exact retry and history fails closed', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const fixture = operatorEntitlementFixture(tenantId);
  let mutationStatus = 409;
  let creates = 0;
  let stateStatus = 200;
  const requests: { key: string; body: unknown }[] = [];
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { csrfToken: 'b'.repeat(43) } }),
  );
  await page.route(
    `**/api/v1/platform/tenants/${tenantId}/entitlements`,
    (route) => route.fulfill({ status: stateStatus, json: fixture }),
  );
  await page.route(
    `**/api/v1/platform/tenants/${tenantId}/entitlement-changes**`,
    (route) => {
      if (route.request().url().endsWith('/preview'))
        return route.fulfill({
          json: {
            at: '2026-12-01T09:00:00.000Z',
            before: fixture.effective,
            after: fixture.effective,
            changes: { employeeLimit: false, billingMode: false },
          },
        });
      creates++;
      const key = route.request().headers()['idempotency-key'];
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      requests.push({ key, body: route.request().postDataJSON() });
      return route.fulfill({
        status: mutationStatus,
        json:
          mutationStatus === 201
            ? {
                id: '44c4bf77-58bb-42ea-9886-5db47c1c3de5',
                version: 1,
                entitlementVersion: 2,
              }
            : {},
      });
    },
  );
  await page.goto(`/platform/companies/${tenantId}/entitlements`);
  await page.getByLabel('Starts at').fill('2026-12-01T09:00:00Z');
  await page.getByLabel('Ends at').fill('2027-01-01T09:00:00Z');
  await page.getByLabel('Control reason').fill('Approved capacity review');
  await page.getByRole('button', { name: 'Preview control' }).click();
  await page.getByRole('button', { name: 'Apply previewed control' }).click();
  await expect(page.getByRole('status')).toHaveText(/Change refused or stale/);
  mutationStatus = 503;
  await page.getByRole('button', { name: 'Preview control' }).click();
  await page.getByRole('button', { name: 'Apply previewed control' }).click();
  await expect(page.getByRole('status')).toHaveText(
    /Further mutations are blocked/,
  );
  await page
    .getByRole('button', { name: 'Refresh entitlement history' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Preview control' }),
  ).toBeDisabled();
  expect(creates).toBe(2);
  await expect(
    page.getByRole('button', { name: 'Retry exact creation request' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry exact creation request' })
    .click();
  expect(requests[2]).toEqual(requests[1]);
  expect(requests[0].key).not.toBe(requests[1].key);
  mutationStatus = 201;
  await page
    .getByRole('button', { name: 'Retry exact creation request' })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    'Creation receipt confirmed. Review current history for effective or revoked status.',
  );
  expect(requests[3]).toEqual(requests[1]);
  await expect(
    page.getByRole('button', { name: 'Retry exact creation request' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Preview control' }),
  ).toBeEnabled();
  stateStatus = 404;
  await page
    .getByRole('button', { name: 'Refresh entitlement history' })
    .click();
  await expect(page.getByRole('main')).toHaveText(
    'An active company with a current subscription is required.',
  );
});

for (const finalStatus of [200, 409, 403]) {
  test(`operator reconciles an uncertain revocation with exact request (${finalStatus})`, async ({
    page,
  }) => {
    const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
    const controlId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
    const fixture = operatorEntitlementFixture(tenantId);
    fixture.controls.push({
      id: controlId,
      kind: 'grant',
      changeType: 'capacity_addon',
      seatDelta: 5,
      employeeLimit: null,
      startsAt: '2026-09-01T00:00:00Z',
      endsAt: '2027-01-01T00:00:00Z',
      status: 'active',
      version: 1,
      reason: 'Synthetic capacity control',
      revokedReason: null,
    });
    let status = 503;
    let historyStatus = 200;
    const attempts: { key: string; url: string; body: unknown }[] = [];
    await page.route('**/api/v1/auth/session', (route) =>
      route.fulfill({ json: { csrfToken: 'b'.repeat(43) } }),
    );
    await page.route(
      `**/api/v1/platform/tenants/${tenantId}/entitlements`,
      (route) => route.fulfill({ status: historyStatus, json: fixture }),
    );
    await page.route(
      `**/api/v1/platform/tenants/${tenantId}/entitlement-changes/grant/${controlId}/revocation`,
      (route) => {
        const request = route.request();
        expect(request.headers()['x-csrf-token']).toBe('b'.repeat(43));
        expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
        expect(request.postDataJSON()).toEqual({
          expectedVersion: 1,
          reason: 'Approved cancellation with exact retry',
        });
        attempts.push({
          key: request.headers()['idempotency-key'],
          url: request.url(),
          body: request.postDataJSON(),
        });
        Object.assign(fixture.controls[0], {
          status: 'revoked',
          version: 2,
          revokedReason: 'Approved cancellation with exact retry',
        });
        fixture.effective.entitlementVersion = 3;
        return route.fulfill({
          status,
          json:
            status === 200
              ? { id: controlId, version: 2, entitlementVersion: 3 }
              : {},
        });
      },
    );
    await page.goto(`/platform/companies/${tenantId}/entitlements`);
    await page
      .getByLabel(`Revocation reason ${controlId}`)
      .fill('Approved cancellation with exact retry');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page
      .getByRole('button', { name: `Revoke control ${controlId}` })
      .click();
    expect(attempts).toHaveLength(0);
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('button', { name: `Revoke control ${controlId}` })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      /Further mutations are blocked/,
    );
    await expect(
      page.getByRole('button', { name: 'Preview control' }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Refresh entitlement history' })
      .click();
    await expect(
      page.getByText('Revocation: Approved cancellation with exact retry'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Revoke control ${controlId}` }),
    ).toHaveCount(0);
    if (finalStatus === 200) {
      historyStatus = 503;
      await page
        .getByRole('button', { name: 'Refresh entitlement history' })
        .click();
      await expect(
        page.getByText(
          'Entitlement controls are unavailable. Refresh and try again.',
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Synthetic Controlled Company' }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Retry exact revocation request' }),
      ).toBeVisible();
    }
    await page
      .getByRole('button', { name: 'Retry exact revocation request' })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      /Further mutations are blocked/,
    );
    expect(attempts[1]).toEqual(attempts[0]);
    status = finalStatus;
    historyStatus = 200;
    await page
      .getByRole('button', { name: 'Retry exact revocation request' })
      .click();
    if (finalStatus === 200) {
      await expect(page.getByRole('status')).toHaveText(
        'Revocation receipt confirmed. Review current history for effective status.',
      );
      await expect(
        page.getByRole('button', { name: 'Preview control' }),
      ).toBeEnabled();
    } else if (finalStatus === 409) {
      await expect(page.getByRole('status')).toHaveText(
        /Change refused or stale/,
      );
      await expect(
        page.getByRole('button', { name: 'Preview control' }),
      ).toBeEnabled();
    } else {
      await expect(page.getByRole('main')).toHaveText(
        /Only an active platform operator/,
      );
    }
    await expect(
      page.getByRole('button', { name: 'Retry exact revocation request' }),
    ).toHaveCount(0);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toEqual(attempts[0]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

async function employeeAccountWorkspaceFixture(
  page: Page,
  roles = ['hr_admin'],
) {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const employee = {
    id: employeeId,
    employeeNumber: 'LOGIN-001',
    name: 'Synthetic Invitee',
    legalName: null,
    status: 'draft',
    version: 1,
    joiningDate: '2026-09-08',
    employmentType: 'monthly_salaried',
    payrollSetup: 'incomplete',
    accountAccess: {
      status: 'not_provisioned',
      membershipVersion: null as number | null,
    },
    finalWorkingDate: null,
    archivedAt: null,
    employmentHistory: [],
    currentAssignment: null,
    assignmentHistory: [],
  };
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        csrfToken: 'b'.repeat(43),
        identityId: '18e19e63-bb7d-4b2d-87e8-2117f065951a',
        selectedTenantId: tenantId,
        tenants: [{ id: tenantId, name: 'Synthetic Company', roles }],
      },
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/employees`, (route) =>
    route.fulfill({ json: { employees: [employee] } }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/organization`, (route) =>
    route.fulfill({
      json: {
        legalEntity: null,
        branches: [],
        departments: [],
        designations: [],
        latestPublishedVersion: 0,
        publishedPolicy: null,
        policyDrafts: [],
      },
    }),
  );
  return { tenantId, employeeId, employee };
}

test('HR provisions employee login with exact retries and verified activation status', async ({
  page,
}) => {
  const { tenantId, employeeId, employee } =
    await employeeAccountWorkspaceFixture(page);
  const accountRequestId = '1e0308ce-05c5-4b96-adb9-f838efbc2b5a';
  const attempts: { key: string; body: unknown }[] = [];
  let status = 'pending_identity_provider';
  let httpStatus = 503;
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/account-invitations`,
    (route) => {
      const request = route.request();
      expect(request.headers()['x-csrf-token']).toBe('b'.repeat(43));
      expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postDataJSON()).toEqual({ email: 'staff@example.com' });
      attempts.push({
        key: request.headers()['idempotency-key'],
        body: request.postDataJSON(),
      });
      return route.fulfill({
        status: httpStatus,
        json:
          httpStatus === 202
            ? { accountRequestId, status, replayed: attempts.length > 1 }
            : {},
      });
    },
  );
  await page.goto('/employees');
  await page
    .getByRole('button', {
      name: 'Set up employee login for Synthetic Invitee',
    })
    .click();
  const form = page.getByRole('region', {
    name: 'Employee login setup for Synthetic Invitee',
  });
  await expect(form.getByRole('checkbox')).toHaveCount(0);
  await page
    .getByLabel('Employee login email for Synthetic Invitee')
    .fill('Staff@Example.COM');
  await page.getByRole('button', { name: 'Send employee setup' }).click();
  await expect(form.getByRole('status')).toHaveText(
    /outcome could not be confirmed/,
  );
  await expect(
    page.getByLabel('Employee login email for Synthetic Invitee'),
  ).toBeDisabled();
  httpStatus = 202;
  for (const progress of [
    'pending_identity_provider',
    'pending_delivery',
    'pending_activation',
  ]) {
    status = progress;
    await page
      .getByRole('button', { name: 'Retry exact employee setup' })
      .click();
    await expect(
      form.getByText(new RegExp(progress.replaceAll('_', ' '))),
    ).toBeVisible();
  }
  expect(attempts).toHaveLength(4);
  expect(
    attempts.every(
      (attempt) => JSON.stringify(attempt) === JSON.stringify(attempts[0]),
    ),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Retry exact employee setup' }),
  ).toHaveCount(0);
  await expect(form.getByRole('status')).toHaveText(/access remains pending/);
  employee.accountAccess = { status: 'active', membershipVersion: 1 };
  await page
    .getByRole('button', {
      name: 'Refresh employee access for Synthetic Invitee',
    })
    .click();
  await expect(page.getByText('Login access: active')).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('employee setup conflicts allow correction while malformed results retain the request and lost authority removes it', async ({
  page,
}) => {
  const { tenantId, employeeId } = await employeeAccountWorkspaceFixture(page, [
    'owner',
  ]);
  let status = 409;
  const attempts: { key: string; body: unknown }[] = [];
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/account-invitations`,
    (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      return route.fulfill({
        status,
        json: { accountRequestId: 'wrong', status: 'active', replayed: true },
      });
    },
  );
  await page.goto('/employees');
  await page
    .getByRole('button', {
      name: 'Set up employee login for Synthetic Invitee',
    })
    .click();
  await page
    .getByLabel('Employee login email for Synthetic Invitee')
    .fill('first@example.com');
  await page.getByRole('button', { name: 'Send employee setup' }).click();
  await expect(page.getByRole('status')).toHaveText(/Account setup refused/);
  await expect(
    page.getByLabel('Employee login email for Synthetic Invitee'),
  ).toBeEnabled();
  await page
    .getByLabel('Employee login email for Synthetic Invitee')
    .fill('second@example.com');
  status = 202;
  await page.getByRole('button', { name: 'Send employee setup' }).click();
  await expect(page.getByRole('status')).toHaveText(
    /outcome could not be confirmed/,
  );
  await expect(page.getByText('Request wrong')).toHaveCount(0);
  expect(attempts[1].key).not.toBe(attempts[0].key);
  status = 403;
  await page
    .getByRole('button', { name: 'Retry exact employee setup' })
    .click();
  await expect(page.getByRole('main')).toHaveText(
    /HR access with recent multi-factor/,
  );
  await expect(
    page.getByRole('button', { name: 'Retry exact employee setup' }),
  ).toHaveCount(0);
  expect(attempts[2]).toEqual(attempts[1]);
});

for (const scenario of [
  'payroll-only',
  'employee-only',
  'revoked',
  'terminated',
] as const) {
  test(`employee login setup is unavailable for ${scenario}`, async ({
    page,
  }) => {
    const roles =
      scenario === 'payroll-only'
        ? ['payroll_preparer']
        : scenario === 'employee-only'
          ? ['employee']
          : ['hr_admin'];
    const { employee } = await employeeAccountWorkspaceFixture(page, roles);
    if (scenario === 'revoked')
      employee.accountAccess = { status: 'revoked', membershipVersion: 2 };
    if (scenario === 'terminated') employee.status = 'terminated';
    await page.goto('/employees');
    await expect(
      page.getByText('Login access:', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Set up employee login for Synthetic Invitee',
      }),
    ).toHaveCount(0);
  });
}

for (const status of ['failed', 'revoked']) {
  test(`employee setup terminal ${status} result never offers a repair or new request`, async ({
    page,
  }) => {
    const { tenantId, employeeId } =
      await employeeAccountWorkspaceFixture(page);
    let requests = 0;
    await page.route(
      `**/api/v1/tenants/${tenantId}/employees/${employeeId}/account-invitations`,
      (route) => {
        requests++;
        return route.fulfill({
          status: 202,
          json: {
            accountRequestId: '1e0308ce-05c5-4b96-adb9-f838efbc2b5a',
            status,
            replayed: true,
          },
        });
      },
    );
    await page.goto('/employees');
    await page
      .getByRole('button', {
        name: 'Set up employee login for Synthetic Invitee',
      })
      .click();
    await page
      .getByLabel('Employee login email for Synthetic Invitee')
      .fill('staff@example.com');
    await page.getByRole('button', { name: 'Send employee setup' }).click();
    await expect(page.getByRole('status')).toHaveText(
      status === 'failed' ? /marked failed/ : /request is revoked/,
    );
    await expect(
      page.getByRole('button', { name: 'Retry exact employee setup' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Send employee setup' }),
    ).toHaveCount(0);
    expect(requests).toBe(1);
  });
}

test('bank details stay hidden from HR and read-only for payroll approvers', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  let roles = ['hr_admin'];
  let reads = 0;
  let fail = false;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: 'b'.repeat(43),
        identityId: '18e19e63-bb7d-4b2d-87e8-2117f065951a',
        selectedTenantId: tenantId,
        tenants: [{ id: tenantId, name: 'Synthetic Bank Company', roles }],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/organization`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        legalEntity: null,
        branches: [],
        departments: [],
        designations: [],
        latestPublishedVersion: 0,
        publishedPolicy: null,
        policyDrafts: [],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${tenantId}/employees`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        employees: [
          {
            id: employeeId,
            employeeNumber: 'BANK-001',
            name: 'Bank Fixture',
            legalName: null,
            status: 'active',
            version: 2,
            joiningDate: '2026-09-01',
            employmentType: 'monthly_salaried',
            payrollSetup: 'incomplete',
            accountAccess: {
              status: 'not_provisioned',
              membershipVersion: null,
            },
            finalWorkingDate: null,
            archivedAt: null,
            employmentHistory: [],
            currentAssignment: null,
            assignmentHistory: [],
          },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/bank-details`,
    (route) => {
      reads++;
      expect(route.request().method()).toBe('GET');
      return route.fulfill({
        status: fail ? 403 : 200,
        contentType: 'application/json',
        body: fail
          ? '{}'
          : JSON.stringify({
              details: {
                id: employeeId,
                version: 1,
                bankName: 'Synthetic Bank',
                accountTitle: 'Synthetic Account',
                accountNumber: '00' + 'A'.repeat(32),
                updatedAt: '2026-10-03T12:00:00.000Z',
              },
            }),
      });
    },
  );
  await page.goto('/employees');
  await expect(
    page.getByRole('heading', { name: 'Synthetic Bank Company' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Load bank details', exact: true }),
  ).toHaveCount(0);
  expect(reads).toBe(0);
  roles = ['hr_admin', 'payroll_approver'];
  await page.reload();
  await page
    .getByRole('button', { name: 'Load bank details', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic Account', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save bank details', exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  fail = true;
  await page
    .getByRole('button', { name: 'Reload bank details', exact: true })
    .click();
  await expect(
    page.getByText(/Bank details could not be loaded/),
  ).toBeVisible();
  await expect(
    page.getByText('Synthetic Account', { exact: true }),
  ).toHaveCount(0);
});

const deviceTenant = '00000000-0000-4000-8000-000000000101';
const deviceBranch = '00000000-0000-4000-8000-000000000102';
const deviceCsrf = 'd'.repeat(43);
const inventoryRow = (n = 1) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  branchId: deviceBranch,
  code: `K50-${n}`,
  name: `Synthetic entrance ${n}`,
  model: 'ZKTeco_K50',
  firmware: null as string | null,
  sourceTimezone: 'Asia/Karachi',
  status: 'draft',
  version: 1,
  adapterVersion: null,
  sourceIdentityStatus: 'unverified',
  health: 'not_connected',
  lastSyncAt: null,
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
});
async function deviceSession(
  page: Page,
  roles = ['owner'],
  selected: string | null = deviceTenant,
  active = true,
) {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        csrfToken: deviceCsrf,
        selectedTenantId: selected,
        tenants: [
          { id: deviceTenant, name: 'Synthetic device company', roles },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${deviceTenant}/organization`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        legalEntity: null,
        branches: [
          {
            id: deviceBranch,
            legalEntityId: deviceBranch,
            code: 'HQ',
            name: 'Synthetic HQ',
            provinceCode: 'PK-PB',
            status: active ? 'active' : 'inactive',
            version: 1,
          },
        ],
        departments: [],
        designations: [],
        latestPublishedVersion: 0,
        publishedPolicy: null,
        policyDrafts: [],
      }),
    }),
  );
}

test('device workspace registers, versions and retires drafts without connecting hardware', async ({
  page,
}) => {
  await deviceSession(page);
  const rows: ReturnType<typeof inventoryRow>[] = [];
  const writes: Record<string, unknown>[] = [];
  await page.route(
    `**/api/v1/tenants/${deviceTenant}/devices**`,
    async (route) => {
      const req = route.request();
      if (req.method() === 'GET')
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: rows, nextCursor: null }),
        });
      expect(req.headers()['x-csrf-token']).toBe(deviceCsrf);
      const input = req.postDataJSON();
      writes.push(input);
      if (req.method() === 'POST') {
        expect(input).toEqual({
          branchId: deviceBranch,
          code: 'K50-1',
          name: 'Synthetic entrance 1',
          model: 'ZKTeco_K50',
          firmware: null,
          sourceTimezone: 'Asia/Karachi',
          reason: 'initial_setup',
        });
        rows.push(inventoryRow());
      } else {
        expect(input.expectedVersion).toBe(rows[0].version);
        expect(input).not.toHaveProperty('code');
        rows[0] = {
          ...rows[0],
          name: input.name,
          firmware: input.firmware,
          status: input.status,
          version: rows[0].version + 1,
        };
      }
      await route.fulfill({
        status: req.method() === 'POST' ? 201 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: rows[0].id, version: rows[0].version }),
      });
    },
  );
  await page.goto('/devices');
  await expect(
    page.getByText('Owner access · draft inventory only.'),
  ).toBeVisible();
  await page.getByLabel('Device code', { exact: true }).fill('lowercase');
  expect(
    await page
      .getByLabel('Device code', { exact: true })
      .evaluate((element) => (element as HTMLInputElement).checkValidity()),
  ).toBe(false);
  await page.getByLabel('Device code', { exact: true }).fill('K50-1');
  await page
    .getByLabel('Device name', { exact: true })
    .fill('Synthetic entrance 1');
  await page
    .getByRole('combobox', { name: 'Branch', exact: true })
    .selectOption(deviceBranch);
  await page.getByLabel('Firmware label (optional)').fill('$invalid');
  await page
    .getByRole('button', { name: 'Register draft device', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('valid firmware label');
  expect(writes).toHaveLength(0);
  await page.getByLabel('Firmware label (optional)').fill('');
  await page
    .getByRole('button', { name: 'Register draft device', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Draft device registered',
  );
  await page.getByRole('button', { name: 'Edit K50-1', exact: true }).click();
  await expect(page.getByLabel('Device code', { exact: true })).toBeDisabled();
  await page
    .getByLabel('Device name', { exact: true })
    .fill('Renamed entrance');
  await page.getByLabel('Firmware label (optional)').fill('synthetic-1');
  await page
    .getByRole('button', { name: 'Save metadata', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Draft metadata updated.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Retire K50-1', exact: true }).click();
  expect(writes).toHaveLength(2);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Retire K50-1', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Device retired; history retained.',
  );
  expect(writes).toHaveLength(3);
  expect(writes[2]).toMatchObject({
    name: 'Renamed entrance',
    firmware: 'synthetic-1',
    expectedVersion: 2,
    status: 'retired',
    reason: 'retire_device',
  });
  await expect(
    page.getByRole('button', { name: 'Edit K50-1', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/Retired history is retained/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
  await page.screenshot({
    path: `test-results/device-workspace-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('device workspace keeps HR read-only and paginates without accumulating stale drafts', async ({
  page,
}) => {
  await deviceSession(page, ['hr_admin']);
  await page.route(`**/api/v1/tenants/${deviceTenant}/devices**`, (route) => {
    expect(route.request().method()).toBe('GET');
    const cursor = new URL(route.request().url()).searchParams.get('afterId');
    const row = inventoryRow(cursor ? 2 : 1);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [row],
        nextCursor: cursor ? null : row.id,
      }),
    });
  });
  await page.goto('/devices');
  await expect(page.getByText('HR access · read only.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Edit K50-1', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('K50-2 · Synthetic entrance 2')).toBeVisible();
  await expect(page.getByText('K50-1 · Synthetic entrance 1')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Next page', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'First page', exact: true }).click();
  await expect(page.getByText('K50-1 · Synthetic entrance 1')).toBeVisible();
});

test('device workspace locks uncertain and conflicting writes until fresh inventory is loaded', async ({
  page,
}) => {
  await deviceSession(page);
  let writes = 0;
  await page.route(`**/api/v1/tenants/${deviceTenant}/devices**`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [inventoryRow()], nextCursor: null }),
      });
    writes++;
    return writes === 1
      ? route.abort('failed')
      : route.fulfill({ status: 409, body: '{}' });
  });
  await page.goto('/devices');
  for (const expected of [
    'The change could not be confirmed',
    'Change refused:',
  ]) {
    await page.getByRole('button', { name: 'Edit K50-1', exact: true }).click();
    await page
      .getByLabel('Device name', { exact: true })
      .fill('Changed entrance');
    await page
      .getByRole('button', { name: 'Save metadata', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(expected);
    await expect(
      page.getByRole('button', { name: 'Edit K50-1', exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('Device name', { exact: true })).toHaveValue(
      '',
    );
    await expect(
      page.getByRole('button', { name: 'Register draft device', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Refresh inventory', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Edit K50-1', exact: true }),
    ).toBeEnabled();
  }
  expect(writes).toBe(2);
});

test('device workspace clears inventory and unsaved fields after access is revoked', async ({
  page,
}) => {
  await deviceSession(page);
  await page.route(`**/api/v1/tenants/${deviceTenant}/devices**`, (route) =>
    route.fulfill({
      status: route.request().method() === 'GET' ? 200 : 403,
      contentType: 'application/json',
      body: JSON.stringify({ items: [inventoryRow()], nextCursor: null }),
    }),
  );
  await page.goto('/devices');
  await page.getByRole('button', { name: 'Edit K50-1', exact: true }).click();
  await page
    .getByLabel('Device name', { exact: true })
    .fill('Private unsaved text');
  await page
    .getByRole('button', { name: 'Save metadata', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('access denied');
  await expect(page.getByText('K50-1 · Synthetic entrance 1')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(
    page.getByText('Synthetic device company · device inventory'),
  ).toHaveCount(0);
});

test('device workspace handles signed-out, unselected and unauthorized company contexts', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, body: '{}' }),
  );
  await page.goto('/devices');
  await expect(page.getByRole('status')).toHaveText(
    'Sign in to view device inventory.',
  );
  await deviceSession(page, ['owner'], null);
  await page
    .getByRole('button', { name: 'Refresh inventory', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Select a company');
  await deviceSession(page, ['employee']);
  await page
    .getByRole('button', { name: 'Refresh inventory', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('access denied');
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('device workspace rejects invalid pages and refreshes without reusing another company authority', async ({
  page,
}) => {
  await deviceSession(page);
  let invalid = false;
  await page.route(`**/api/v1/tenants/${deviceTenant}/devices**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [inventoryRow()],
        nextCursor: invalid ? inventoryRow(2).id : null,
      }),
    }),
  );
  await page.goto('/devices');
  await expect(page.getByText('K50-1 · Synthetic entrance 1')).toBeVisible();
  invalid = true;
  await page
    .getByRole('button', { name: 'Refresh inventory', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('unavailable');
  await expect(page.getByText('K50-1 · Synthetic entrance 1')).toHaveCount(0);
  invalid = false;
  await deviceSession(page, ['hr_admin']);
  await page
    .getByRole('button', { name: 'Refresh inventory', exact: true })
    .click();
  await expect(page.getByText('HR access · read only.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('device workspace permits retirement on inactive branches but blocks draft registration', async ({
  page,
}) => {
  await deviceSession(page, ['owner'], deviceTenant, false);
  let writes = 0;
  const row = inventoryRow();
  await page.route(`**/api/v1/tenants/${deviceTenant}/devices**`, (route) => {
    if (route.request().method() !== 'GET') {
      writes++;
      expect(route.request().method()).toBe('PUT');
      expect(route.request().postDataJSON()).toMatchObject({
        branchId: deviceBranch,
        status: 'retired',
        reason: 'retire_device',
      });
      row.status = 'retired';
      row.version = 2;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: row.id, version: 2 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [row], nextCursor: null }),
    });
  });
  await page.goto('/devices');
  await expect(
    page.getByRole('button', { name: 'Register draft device', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/Create or activate a branch/)).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Retire K50-1', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Device retired; history retained.',
  );
  expect(writes).toBe(1);
});

const allocationSnapshot = (version = 0, enabled = false) => ({
  tenantId: deviceTenant,
  version,
  enabled,
  deviceLimit: enabled ? 3 : 0,
  connectorLimit: enabled ? 2 : 0,
  configuredAt: version ? '2026-10-04T00:00:00Z' : null,
  machineAccessAvailable: false,
});
const allocationPath = `/api/v1/platform/tenants/${deviceTenant}/attendance-entitlements`;
const allocationPage = `/platform/companies/${deviceTenant}/attendance`;
async function reviewAllocation(page: Page) {
  await page.getByLabel('Attendance enabled').check();
  await page.getByLabel('Device limit', { exact: true }).fill('3');
  await page.getByLabel('Connector limit', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Review allocation change' }).click();
}

test('attendance allocation operator reviews, applies and disables without machine access', async ({
  page,
}) => {
  await deviceSession(page);
  let snapshot = allocationSnapshot();
  const writes: Record<string, unknown>[] = [];
  await page.route(`**${allocationPath}`, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: snapshot });
    const input = req.postDataJSON();
    writes.push(input);
    expect(req.headers()['x-csrf-token']).toBe(deviceCsrf);
    expect(req.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
    snapshot = allocationSnapshot(snapshot.version + 1, input.enabled);
    return route.fulfill({
      json: { id: deviceBranch, version: snapshot.version, replayed: false },
    });
  });
  await page.goto(allocationPage);
  await expect(page.getByText('Configured: Not configured')).toBeVisible();
  await reviewAllocation(page);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Confirm allocation change' }).click();
  await expect(
    page.getByText('Allocation version: 1', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Attendance enabled').uncheck();
  await page.getByRole('button', { name: 'Review allocation change' }).click();
  await page.getByRole('button', { name: 'Confirm allocation change' }).click();
  await expect(
    page.getByText('Allocation version: 2', { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      expectedVersion: 0,
      enabled: true,
      deviceLimit: 3,
      connectorLimit: 2,
      reason: 'initial_setup',
    },
    {
      expectedVersion: 1,
      enabled: false,
      deviceLimit: 0,
      connectorLimit: 0,
      reason: 'disable_attendance',
    },
  ]);
  await expect(page.getByText(/Machine access is unavailable/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('attendance allocation uncertain save retains exact retry across refresh and later disable', async ({
  page,
}) => {
  await deviceSession(page);
  let snapshot = allocationSnapshot();
  const requests: { body: string | null; key: string }[] = [];
  let token = deviceCsrf;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { csrfToken: token } }),
  );
  await page.route(`**${allocationPath}`, (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: snapshot });
    requests.push({
      body: req.postData(),
      key: req.headers()['idempotency-key'],
    });
    if (requests.length === 1) {
      snapshot = allocationSnapshot(2, false); // original save committed, then another operator disabled
      return route.abort();
    }
    expect(req.headers()['x-csrf-token']).toBe('fresh-csrf');
    return route.fulfill({
      json: { id: deviceBranch, version: 1, replayed: true },
    });
  });
  await page.goto(allocationPage);
  await reviewAllocation(page);
  await page.getByRole('button', { name: 'Confirm allocation change' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry exact allocation request' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Refresh attendance allocation' })
    .click();
  await expect(
    page.getByText('Allocation version: 2', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review allocation change' }),
  ).toBeDisabled();
  token = 'fresh-csrf';
  await page
    .getByRole('button', { name: 'Retry exact allocation request' })
    .click();
  await expect(page.getByText(/Allocation receipt confirmed/)).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(
    page.getByText('Attendance allocation: Disabled', { exact: true }),
  ).toBeVisible();
});

test('attendance allocation conflicts require refreshed version and changed reviews are invalidated', async ({
  page,
}) => {
  await deviceSession(page);
  let snapshot = allocationSnapshot();
  let writes = 0;
  await page.route(`**${allocationPath}`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: snapshot });
    writes++;
    snapshot = allocationSnapshot(1, true);
    return route.fulfill({ status: 409, json: {} });
  });
  await page.goto(allocationPage);
  await reviewAllocation(page);
  await page.getByLabel('Device limit', { exact: true }).fill('4');
  await expect(
    page.getByRole('button', { name: 'Confirm allocation change' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Review allocation change' }).click();
  await page.getByRole('button', { name: 'Confirm allocation change' }).click();
  await expect(page.getByText(/Change refused or stale/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review allocation change' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Retry exact allocation request' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Refresh attendance allocation' })
    .click();
  await expect(
    page.getByText('Allocation version: 1', { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
});

test('attendance allocation revoked operator cannot retry and loses retained data', async ({
  page,
}) => {
  await deviceSession(page);
  let writes = 0;
  let sessionDenied = false;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: sessionDenied ? 401 : 200,
      json: { csrfToken: deviceCsrf },
    }),
  );
  await page.route(`**${allocationPath}`, (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: allocationSnapshot() });
    writes++;
    return route.abort();
  });
  await page.goto(allocationPage);
  await reviewAllocation(page);
  await page.getByRole('button', { name: 'Confirm allocation change' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry exact allocation request' }),
  ).toBeVisible();
  sessionDenied = true;
  await page
    .getByRole('button', { name: 'Retry exact allocation request' })
    .click();
  await expect(
    page.getByText('Sign in to review attendance allocation.'),
  ).toBeVisible();
  await expect(page.getByText(/Unconfirmed request:/)).toHaveCount(0);
  await expect(page.getByText(`Company: ${deviceTenant}`)).toHaveCount(0);
  expect(writes).toBe(1);
});

test('attendance allocation company view is read-only, selection-aware and fails closed', async ({
  page,
}) => {
  await deviceSession(page, ['hr_admin']);
  let invalid = false;
  await page.route(
    `**/api/v1/tenants/${deviceTenant}/attendance-entitlements`,
    (route) => {
      expect(route.request().method()).toBe('GET');
      return route.fulfill({
        json: {
          ...allocationSnapshot(1, true),
          ...(invalid ? { machineAccessAvailable: true } : {}),
        },
      });
    },
  );
  await page.goto('/attendance-capacity');
  await expect(
    page.getByText('Device limit: 3 · Connector limit: 2'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review allocation change' }),
  ).toHaveCount(0);
  invalid = true;
  await page
    .getByRole('button', { name: 'Refresh attendance allocation' })
    .click();
  await expect(
    page.getByText('Attendance allocation is unavailable.'),
  ).toBeVisible();
  await expect(
    page.getByText('Device limit: 3 · Connector limit: 2'),
  ).toHaveCount(0);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { csrfToken: deviceCsrf, selectedTenantId: null } }),
  );
  await page
    .getByRole('button', { name: 'Refresh attendance allocation' })
    .click();
  await expect(
    page.getByText('Choose a company workspace first.'),
  ).toBeVisible();
});

test('attendance allocation rejects employee access and wrong-company operator responses', async ({
  page,
}) => {
  await deviceSession(page, ['employee']);
  let reads = 0;
  await page.route(
    `**/api/v1/tenants/${deviceTenant}/attendance-entitlements`,
    (route) => {
      reads++;
      return route.fulfill({ json: allocationSnapshot() });
    },
  );
  await page.goto('/attendance-capacity');
  await expect(
    page.getByText(/Recent verification and authorized access/),
  ).toBeVisible();
  expect(reads).toBe(0);
  await page.route(`**${allocationPath}`, (route) =>
    route.fulfill({
      json: { ...allocationSnapshot(1, true), tenantId: deviceBranch },
    }),
  );
  await page.goto(allocationPage);
  await expect(
    page.getByText('Attendance allocation is unavailable.'),
  ).toBeVisible();
  await expect(
    page.getByText('Device limit: 3 · Connector limit: 2'),
  ).toHaveCount(0);
});

test('attendance allocation platform proxy reaches protected API without bypassing authentication', async ({
  page,
}) => {
  const response = await page.request.get(allocationPath);
  const direct = await page.request.get(
    `http://127.0.0.1:4000${allocationPath}`,
  );
  // Disabled authentication intentionally hides protected routes with 404.
  expect([401, 404]).toContain(direct.status());
  expect(response.status()).toBe(direct.status());
  const proxiedBody = await response.json();
  const directBody = await direct.json();
  expect(proxiedBody.requestId).toBe(response.headers()['x-request-id']);
  expect(proxiedBody.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect({ ...proxiedBody, requestId: null }).toEqual({
    ...directBody,
    requestId: null,
  });
});

test('attendance allocation malformed receipt reconciles exactly and confirmed read failure never repeats save', async ({
  page,
}) => {
  await deviceSession(page);
  let readsFail = false;
  const keys: string[] = [];
  await page.route(`**${allocationPath}`, (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({
        status: readsFail ? 503 : 200,
        json: allocationSnapshot(keys.length ? 1 : 0, keys.length > 0),
      });
    keys.push(req.headers()['idempotency-key']);
    if (keys.length === 1)
      return route.fulfill({
        json: { id: deviceBranch, version: 99, replayed: false },
      });
    readsFail = true;
    return route.fulfill({
      json: { id: deviceBranch, version: 1, replayed: true },
    });
  });
  await page.goto(allocationPage);
  await reviewAllocation(page);
  await page.getByRole('button', { name: 'Confirm allocation change' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry exact allocation request' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry exact allocation request' })
    .click();
  await expect(
    page.getByText(
      'Allocation receipt confirmed, but current state could not be loaded. Refresh before making another change.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry exact allocation request' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Review allocation change' }),
  ).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  readsFail = false;
  await page
    .getByRole('button', { name: 'Refresh attendance allocation' })
    .click();
  await expect(
    page.getByText('Allocation version: 1', { exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
});

test('default API keeps synthetic connector admission and owner workflows disabled', async ({
  request,
}) => {
  const api = 'http://127.0.0.1:4000/api/v1';
  const redemption = await request.post(
    api + '/local-machine/connectors/redemption',
    { data: { token: 'ke1_' + 'a'.repeat(43) } },
  );
  expect(redemption.status()).toBe(404);
  const heartbeat = await request.post(
    api + '/local-machine/connectors/heartbeat',
    { headers: { authorization: 'Bearer kc1_' + 'b'.repeat(43) }, data: {} },
  );
  expect(heartbeat.status()).toBe(404);
  const owner = await request.get(
    api +
      '/tenants/00000000-0000-4000-8000-000000000001/local-connectors/credentials',
  );
  expect(owner.status()).toBe(404);
});

const connectorIdentity = '00000000-0000-4000-8000-000000000104';
const connectorBase = `/api/v1/tenants/${deviceTenant}/local-connectors`;
const enrollmentRow = (n = 201) => {
  const createdAt = new Date().toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    deviceId: inventoryRow().id,
    expectedDeviceVersion: 1,
    allocationVersion: 1,
    version: 1,
    status: 'issued',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 900000).toISOString(),
    revokedAt: null,
  };
};
const credentialRow = (n = 301) => {
  const createdAt = new Date().toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tenantId: deviceTenant,
    deviceId: inventoryRow().id,
    enrollmentId: enrollmentRow().id,
    version: 1,
    status: 'active',
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 2592000000).toISOString(),
    revokedAt: null as string | null,
    scope: 'heartbeat_only',
    attendanceIngestionAvailable: false,
  };
};
async function connectorSetup(page: Page, roles = ['owner']) {
  await deviceSession(page, roles);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identityId: connectorIdentity,
        csrfToken: deviceCsrf,
        selectedTenantId: deviceTenant,
        tenants: [
          { id: deviceTenant, name: 'Synthetic device company', roles },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/tenants/${deviceTenant}/devices**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [inventoryRow()], nextCursor: null }),
    }),
  );
  await page.route(
    `**/api/v1/tenants/${deviceTenant}/attendance-entitlements`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(allocationSnapshot(1, true)),
      }),
  );
  await page.route(`**${connectorBase}/enrollment-tokens**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [],
        nextCursor: null,
        machineAccessAvailable: false,
      }),
    }),
  );
  await page.route(`**${connectorBase}/credentials**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
}
const issueFromWorkspace = async (page: Page) => {
  await page
    .getByRole('combobox', { name: 'Draft device', exact: true })
    .selectOption(inventoryRow().id);
  await page
    .getByRole('button', { name: 'Issue enrollment token', exact: true })
    .click();
};
test('connector workspace reveals a token once, clears it on hiding/refresh, and fits the viewport', async ({
  page,
}) => {
  await connectorSetup(page);
  const token = 'ke1_' + 'a'.repeat(43),
    row = enrollmentRow();
  let reads = 0,
    writes = 0;
  await page.route(`**${connectorBase}/enrollment-tokens**`, (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      reads++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: writes ? [row] : [],
          nextCursor: null,
          machineAccessAvailable: false,
        }),
      });
    }
    writes++;
    expect(req.headers()['x-csrf-token']).toBe(deviceCsrf);
    expect(req.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
    expect(req.postDataJSON()).toEqual({
      deviceId: inventoryRow().id,
      expectedDeviceVersion: 1,
      expectedAllocationVersion: 1,
    });
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        enrollment: row,
        replayed: false,
        token,
        machineAccessAvailable: false,
      }),
    });
  });
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveValue(token);
  await expect(
    page.getByRole('button', { name: 'Issue enrollment token', exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(token);
  expect(page.url()).not.toContain(token);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Hide enrollment token', exact: true })
    .click();
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Enrollment history' }),
  ).toContainText(row.id);
  expect(writes).toBe(1);
  expect(reads).toBe(2);
});
test('connector workspace preserves the exact uncertain issue across refresh and never recovers its secret', async ({
  page,
}) => {
  await connectorSetup(page);
  const row = enrollmentRow();
  const requests: {
    key: string | undefined;
    body: unknown;
    csrf: string | undefined;
  }[] = [];
  let csrf = deviceCsrf;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identityId: connectorIdentity,
        csrfToken: csrf,
        selectedTenantId: deviceTenant,
        tenants: [
          {
            id: deviceTenant,
            name: 'Synthetic device company',
            roles: ['owner'],
          },
        ],
      }),
    }),
  );
  await page.route(`**${connectorBase}/enrollment-tokens**`, (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: requests.length ? [row] : [],
          nextCursor: null,
          machineAccessAvailable: false,
        }),
      });
    requests.push({
      key: req.headers()['idempotency-key'],
      body: req.postDataJSON(),
      csrf: req.headers()['x-csrf-token'],
    });
    return route.fulfill({
      status: requests.length === 1 ? 500 : 201,
      contentType: 'application/json',
      body: JSON.stringify(
        requests.length === 1
          ? {}
          : {
              enrollment: row,
              replayed: true,
              token: null,
              machineAccessAvailable: false,
            },
      ),
    });
  });
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  csrf = 'e'.repeat(43);
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Issue enrollment token', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Retry exact command', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'original token cannot be recovered',
  );
  expect(requests).toHaveLength(2);
  expect(requests[1].key).toBe(requests[0].key);
  expect(requests[1].body).toEqual(requests[0].body);
  expect(requests[1].csrf).toBe(csrf);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveCount(0);
});
test('connector metadata is read-only for HR and unavailable when local mode is disabled', async ({
  page,
}) => {
  await connectorSetup(page, ['hr_admin']);
  const row = credentialRow();
  await page.route(`**${connectorBase}/credentials**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [row], nextCursor: null }),
    }),
  );
  await page.goto('/connectors');
  await expect(page.getByText(/HR read-only access/)).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /Issue enrollment|Revoke credential|Revoke enrollment/,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Connector credentials' }),
  ).toContainText(row.id);
  await page.route(`**${connectorBase}/credentials**`, (route) =>
    route.fulfill({ status: 404, body: '{}' }),
  );
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(
    page.getByText(/Local connector HTTP mode is disabled/),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Connector credentials' }),
  ).toHaveCount(0);
});
test('connector revocation requires confirmation and keeps a failed response locked for exact retry', async ({
  page,
}) => {
  await connectorSetup(page);
  let row = credentialRow();
  let writes = 0;
  const payloads: unknown[] = [];
  await page.route(`**${connectorBase}/credentials**`, (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [row], nextCursor: null }),
      });
    writes++;
    payloads.push(req.postDataJSON());
    row = {
      ...row,
      status: 'revoked',
      version: 2,
      revokedAt: new Date().toISOString(),
    };
    return route.fulfill({
      status: writes === 1 ? 500 : 201,
      contentType: 'application/json',
      body: JSON.stringify(writes === 1 ? {} : row),
    });
  });
  await page.goto('/connectors');
  const revoke = page.getByRole('button', {
    name: 'Revoke credential ' + row.id,
    exact: true,
  });
  page.once('dialog', (dialog) => dialog.dismiss());
  await revoke.click();
  expect(writes).toBe(0);
  page.once('dialog', (dialog) => dialog.accept());
  await revoke.click();
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Revoke credential/ }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Retry exact command', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Revocation confirmed');
  expect(payloads).toEqual([{ expectedVersion: 1 }, { expectedVersion: 1 }]);
});
test('connector workspace clears uncertain requests on company or owner access changes', async ({
  page,
}) => {
  await connectorSetup(page);
  let selected = deviceTenant,
    writes = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identityId: connectorIdentity,
        csrfToken: deviceCsrf,
        selectedTenantId: selected,
        tenants: [{ id: selected, name: 'Current company', roles: ['owner'] }],
      }),
    }),
  );
  await page.route(`**${connectorBase}/enrollment-tokens`, (route) =>
    route.request().method() === 'POST'
      ? (writes++, route.fulfill({ status: 500, body: '{}' }))
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            nextCursor: null,
            machineAccessAvailable: false,
          }),
        }),
  );
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  selected = '00000000-0000-4000-8000-000000000999';
  await page
    .getByRole('button', { name: 'Retry exact command', exact: true })
    .click();
  await expect(page.getByText(/Connector access is unavailable/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry exact command', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Current company', { exact: true })).toHaveCount(
    0,
  );
  expect(writes).toBe(1);
});
test('connector workspace rejects malformed receipts and cross-company credentials without displaying tokens', async ({
  page,
}) => {
  await connectorSetup(page);
  const token = 'ke1_' + 'z'.repeat(43);
  await page.route(`**${connectorBase}/enrollment-tokens`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            enrollment: { ...enrollmentRow(), deviceId: inventoryRow(2).id },
            replayed: false,
            token,
            machineAccessAvailable: false,
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            nextCursor: null,
            machineAccessAvailable: false,
          }),
        }),
  );
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveCount(0);
  await page.route(`**${connectorBase}/credentials**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            ...credentialRow(),
            tenantId: '00000000-0000-4000-8000-000000000999',
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(page.getByText(/metadata could not be verified/)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Connector credentials' }),
  ).toHaveCount(0);
});
test('connector token disappears on expiry and page hiding', async ({
  page,
}) => {
  await connectorSetup(page);
  const row = enrollmentRow();
  await page.clock.install({ time: new Date(row.createdAt) });
  await page.route(`**${connectorBase}/enrollment-tokens`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            enrollment: row,
            replayed: false,
            token: 'ke1_' + 'a'.repeat(43),
            machineAccessAvailable: false,
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            nextCursor: null,
            machineAccessAvailable: false,
          }),
        }),
  );
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(900001);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveCount(0);
  await page.clock.setSystemTime(new Date(row.createdAt));
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await issueFromWorkspace(page);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveCount(0);
});

test('connector workspace paginates ordered bounded metadata and rejects a malformed cursor', async ({
  page,
}) => {
  await connectorSetup(page);
  const rows = Array.from({ length: 25 }, (_, index) =>
    credentialRow(301 + index),
  );
  let invalid = false;
  const seen: string[] = [];
  await page.route(`**${connectorBase}/credentials**`, (route) => {
    const after = new URL(route.request().url()).searchParams.get('afterId');
    if (after) seen.push(after);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        after
          ? { items: [credentialRow(326)], nextCursor: null }
          : {
              items: rows,
              nextCursor: invalid ? credentialRow(399).id : rows.at(-1)!.id,
            },
      ),
    });
  });
  await page.goto('/connectors');
  await expect(
    page.getByRole('heading', {
      name: 'Credential ' + rows[0].id,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Next credentials page', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Credential ' + credentialRow(326).id,
      exact: true,
    }),
  ).toBeVisible();
  expect(seen).toEqual([rows.at(-1)!.id]);
  await expect(
    page.getByRole('heading', {
      name: 'Credential ' + rows[0].id,
      exact: true,
    }),
  ).toHaveCount(0);
  invalid = true;
  await page
    .getByRole('button', { name: 'First credentials page', exact: true })
    .click();
  await expect(page.getByText(/metadata could not be verified/)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Connector credentials' }),
  ).toHaveCount(0);
});
test('connector workspace refreshes rejected versions before allowing a new issuance', async ({
  page,
}) => {
  await connectorSetup(page);
  let version = 1;
  const writes: { key: string | undefined; version: number }[] = [];
  await page.route(
    `**/api/v1/tenants/${deviceTenant}/attendance-entitlements`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(allocationSnapshot(version, true)),
      }),
  );
  await page.route(`**${connectorBase}/enrollment-tokens`, (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [],
          nextCursor: null,
          machineAccessAvailable: false,
        }),
      });
    writes.push({
      key: req.headers()['idempotency-key'],
      version: req.postDataJSON().expectedAllocationVersion,
    });
    version = 2;
    return route.fulfill({
      status: writes.length === 1 ? 409 : 201,
      contentType: 'application/json',
      body: JSON.stringify(
        writes.length === 1
          ? {}
          : {
              enrollment: { ...enrollmentRow(), allocationVersion: 2 },
              replayed: false,
              token: 'ke1_' + 'a'.repeat(43),
              machineAccessAvailable: false,
            },
      ),
    });
  });
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(page.getByRole('status')).toContainText('Command rejected');
  await expect(
    page.getByRole('button', { name: 'Issue enrollment token', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry exact command', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await issueFromWorkspace(page);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toBeVisible();
  expect(writes.map((item) => item.version)).toEqual([1, 2]);
  expect(writes[0].key).not.toBe(writes[1].key);
});
test('connector workspace erases a displayed secret and metadata after access denial', async ({
  page,
}) => {
  await connectorSetup(page);
  let denied = false;
  const row = enrollmentRow();
  await page.route(`**${connectorBase}/enrollment-tokens`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            enrollment: row,
            replayed: false,
            token: 'ke1_' + 'a'.repeat(43),
            machineAccessAvailable: false,
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            nextCursor: null,
            machineAccessAvailable: false,
          }),
        }),
  );
  await page.route(`**${connectorBase}/credentials**`, (route) =>
    route.fulfill({
      status: denied ? 403 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toBeVisible();
  denied = true;
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(page.getByText(/Connector access is unavailable/)).toBeVisible();
  await expect(
    page.getByLabel('Enrollment token', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Enrollment history' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Issue enrollment token', exact: true }),
  ).toHaveCount(0);
});

test('connector workspace requires a selected authorized session before requesting company records', async ({
  page,
}) => {
  await connectorSetup(page);
  let mode = 'selection',
    reads = 0;
  await page.route(`**${connectorBase}/credentials**`, (route) => {
    reads++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: mode === 'signed-out' ? 401 : 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identityId: connectorIdentity,
        csrfToken: deviceCsrf,
        selectedTenantId: mode === 'selection' ? null : deviceTenant,
        tenants: [
          {
            id: deviceTenant,
            name: 'Synthetic device company',
            roles: ['employee'],
          },
        ],
      }),
    }),
  );
  await page.goto('/connectors');
  await expect(
    page.getByText(/Select a company before viewing connectors/),
  ).toBeVisible();
  mode = 'denied';
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(page.getByText(/Connector access is unavailable/)).toBeVisible();
  mode = 'signed-out';
  await page
    .getByRole('button', { name: 'Refresh connector metadata', exact: true })
    .click();
  await expect(
    page.getByText('Sign in to view connectors.', { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(0);
});
test('connector workspace cannot issue while allocation is disabled', async ({
  page,
}) => {
  await connectorSetup(page);
  await page.route(
    `**/api/v1/tenants/${deviceTenant}/attendance-entitlements`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(allocationSnapshot()),
      }),
  );
  await page.goto('/connectors');
  await expect(
    page.getByText(/Attendance allocation is disabled/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Issue enrollment token', exact: true }),
  ).toBeDisabled();
});

test('connector workspace revokes a pending enrollment and requires a metadata refresh before new writes', async ({
  page,
}) => {
  await connectorSetup(page);
  const row = enrollmentRow();
  let writes = 0;
  await page.route(`**${connectorBase}/enrollment-tokens**`, (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [row],
          nextCursor: null,
          machineAccessAvailable: false,
        }),
      });
    writes++;
    expect(req.url()).toContain('/' + row.id + '/revocation');
    expect(req.postDataJSON()).toEqual({ expectedVersion: 1 });
    expect(req.headers()['x-csrf-token']).toBe(deviceCsrf);
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ...row,
        status: 'revoked',
        version: 2,
        revokedAt: new Date().toISOString(),
      }),
    });
  });
  await page.goto('/connectors');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Revoke enrollment ' + row.id, exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Revocation confirmed');
  await expect(
    page.getByRole('button', {
      name: 'Revoke enrollment ' + row.id,
      exact: true,
    }),
  ).toBeDisabled();
  expect(writes).toBe(1);
});

test('connector workspace never retries actor-scoped issuance under another owner in the same company', async ({
  page,
}) => {
  await connectorSetup(page);
  let identityId = connectorIdentity,
    writes = 0;
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        identityId,
        csrfToken: deviceCsrf,
        selectedTenantId: deviceTenant,
        tenants: [
          {
            id: deviceTenant,
            name: 'Synthetic device company',
            roles: ['owner'],
          },
        ],
      }),
    }),
  );
  await page.route(`**${connectorBase}/enrollment-tokens`, (route) =>
    route.request().method() === 'POST'
      ? (writes++, route.fulfill({ status: 500, body: '{}' }))
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [],
            nextCursor: null,
            machineAccessAvailable: false,
          }),
        }),
  );
  await page.goto('/connectors');
  await issueFromWorkspace(page);
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  identityId = '00000000-0000-4000-8000-000000000888';
  await page
    .getByRole('button', { name: 'Retry exact command', exact: true })
    .click();
  await expect(page.getByText(/Connector access is unavailable/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry exact command', exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
});

const mappingEmployeeId = '00000000-0000-4000-8000-000000000601';
const mappingHistory = (n = 701) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  deviceId: inventoryRow().id,
  employeeId: mappingEmployeeId,
  sourceUserId: '0007',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveUntil: null as string | null,
  version: 1,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
});
async function mappingFixture(page: Page) {
  const state = {
    selected: deviceTenant as string | null,
    identity: connectorIdentity,
    roles: ['owner'],
    csrf: deviceCsrf,
    sessionStatus: 200,
    readStatus: 200,
    writeStatus: 201,
    badList: false,
    badReceipt: false,
    resolveStatus: 'mapped',
    devices: [inventoryRow()],
    rows: [] as ReturnType<typeof mappingHistory>[],
    employees: [
      {
        id: mappingEmployeeId,
        employeeNumber: 'MAP-01',
        name: 'Synthetic Mapping Employee',
        legalName: null,
        status: 'draft',
        version: 1,
        joiningDate: '2026-10-01',
        employmentType: 'monthly_salaried',
        payrollSetup: 'incomplete',
        accountAccess: { status: 'not_provisioned', membershipVersion: null },
        finalWorkingDate: null,
        archivedAt: null as string | null,
        employmentHistory: [],
        currentAssignment: null,
        assignmentHistory: [],
      },
    ],
    writes: [] as {
      key: string;
      csrf: string;
      url: string;
      body: Record<string, unknown>;
    }[],
  };
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: state.sessionStatus,
      json: {
        identityId: state.identity,
        csrfToken: state.csrf,
        selectedTenantId: state.selected,
        tenants: [
          {
            id: state.selected ?? deviceTenant,
            name: 'Synthetic Mapping Company',
            roles: state.roles,
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/tenants/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === 'POST') {
      state.writes.push({
        key: req.headers()['idempotency-key'],
        csrf: req.headers()['x-csrf-token'],
        url: url.pathname,
        body: req.postDataJSON(),
      });
      if (state.writeStatus !== 201)
        return route.fulfill({ status: state.writeStatus, json: {} });
      if (state.badReceipt)
        return route.fulfill({
          json: { id: mappingHistory().id, version: 99, replayed: false },
        });
      const last = state.writes.at(-1)!,
        replayed = state.writes.slice(0, -1).some((w) => w.key === last.key);
      const body = last.body;
      const ending = url.pathname.endsWith('/end');
      if (!replayed) {
        if (ending) {
          const row = state.rows.find((v) => url.pathname.includes(v.id))!;
          row.version++;
          row.effectiveUntil = body.effectiveUntil as string;
        } else
          state.rows.push({
            ...mappingHistory(),
            employeeId: body.employeeId as string,
            sourceUserId: body.sourceUserId as string,
            effectiveFrom: body.effectiveFrom as string,
            effectiveUntil: body.effectiveUntil as string | null,
          });
      }
      return route.fulfill({
        status: 201,
        json: {
          id: mappingHistory().id,
          version: ending ? Number(body.expectedVersion) + 1 : 1,
          replayed,
        },
      });
    }
    if (state.readStatus !== 200)
      return route.fulfill({ status: state.readStatus, json: {} });
    if (url.pathname.endsWith('/employees'))
      return route.fulfill({ json: { employees: state.employees } });
    const after = url.searchParams.get('afterId');
    if (url.pathname.endsWith('/devices')) {
      const items = state.devices
        .filter((v) => !after || v.id > after)
        .sort((a, b) => a.id.localeCompare(b.id));
      return route.fulfill({
        json: {
          items: items.slice(0, 25),
          nextCursor: items.length > 25 ? items[24].id : null,
        },
      });
    }
    const deviceId = url.pathname.split('/')[6];
    if (url.pathname.endsWith('/resolve')) {
      expect(url.searchParams.get('sourceUserId')).toBe('0007');
      expect(url.searchParams.get('at')).toBe('2026-10-02T00:00:00.000Z');
      return route.fulfill({
        json:
          state.resolveStatus === 'mapped'
            ? {
                status: 'mapped',
                mappingId: mappingHistory().id,
                mappingVersion: 1,
                employeeId: mappingEmployeeId,
              }
            : {
                status: state.resolveStatus,
                mappingId: null,
                mappingVersion: null,
                employeeId: null,
              },
      });
    }
    const items = state.rows
      .filter((v) => v.deviceId === deviceId && (!after || v.id > after))
      .sort((a, b) => a.id.localeCompare(b.id));
    return route.fulfill({
      json: {
        tenantId: state.badList ? mappingEmployeeId : deviceTenant,
        deviceId,
        items: items.slice(0, 25),
        nextCursor: items.length > 25 ? items[24].id : null,
        attendanceProcessingAvailable: false,
      },
    });
  });
  return state;
}
async function fillMapping(page: Page) {
  await page
    .getByRole('combobox', { name: 'Employee', exact: true })
    .selectOption(mappingEmployeeId);
  await page.getByLabel('Source user ID', { exact: true }).fill('0007');
  await page
    .getByLabel('Effective start (UTC or explicit offset)', { exact: true })
    .fill('2026-10-01T05:00:00+05:00');
}
test('mapping workspace creates exact string assignments, ends with confirmation and resolves event-time history', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  await page.goto('/device-mappings');
  await fillMapping(page);
  await page
    .getByRole('button', { name: 'Create employee mapping', exact: true })
    .click();
  await expect(
    page.getByText('Change confirmed. Refresh history before another change.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes[0].body).toEqual({
    employeeId: mappingEmployeeId,
    sourceUserId: '0007',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveUntil: null,
    reason: 'initial_mapping',
  });
  expect(state.writes[0].key).toMatch(/^[a-f0-9-]{36}$/);
  await expect(
    page.getByRole('button', { name: 'Create employee mapping', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(
    page.getByRole('heading', { name: 'Source ID 0007' }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Mapping to end', exact: true })
    .selectOption(mappingHistory().id);
  await page
    .getByLabel('New exclusive end (UTC or explicit offset)', { exact: true })
    .fill('2026-10-02T05:00:00+05:00');
  page.once('dialog', (d) => d.dismiss());
  await page
    .getByRole('button', { name: 'End employee mapping', exact: true })
    .click();
  expect(state.writes).toHaveLength(1);
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('button', { name: 'End employee mapping', exact: true })
    .click();
  await expect(
    page.getByText('Change confirmed. Refresh history before another change.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(state.writes[1].body).toEqual({
    expectedVersion: 1,
    effectiveUntil: '2026-10-02T00:00:00.000Z',
    reason: 'end_mapping',
  });
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await page.getByLabel('Lookup source ID', { exact: true }).fill('0007');
  await page
    .getByLabel('Event instant (UTC or explicit offset)', { exact: true })
    .fill('2026-10-02T05:00:00+05:00');
  await page
    .getByRole('button', { name: 'Resolve employee mapping', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Mapped to Synthetic Mapping Employee',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
});
test('mapping workspace keeps HR read-only and retains retired history without creating new assignments', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.roles = ['hr_admin'];
  state.rows = [mappingHistory()];
  state.devices[0].status = 'retired';
  await page.goto('/device-mappings');
  await expect(
    page.getByText('Synthetic Mapping Company · HR read-only'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Source ID 0007' }),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Create mapping' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('form', { name: 'End mapping' })).toHaveCount(0);
  state.roles = ['owner'];
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(
    page.getByRole('button', { name: 'Create employee mapping', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'End employee mapping', exact: true }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});
test('mapping workspace retains exact uncertain requests across refresh with fresh CSRF and no new writes', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.writeStatus = 503;
  await page.goto('/device-mappings');
  await fillMapping(page);
  await page
    .getByRole('button', { name: 'Create employee mapping', exact: true })
    .click();
  await expect(page.getByText(/Outcome unknown/)).toBeVisible();
  const original = state.writes[0];
  state.csrf = 'e'.repeat(43);
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(
    page.getByRole('button', { name: 'Create employee mapping', exact: true }),
  ).toBeDisabled();
  state.writeStatus = 201;
  await page
    .getByRole('button', { name: 'Retry exact mapping request' })
    .click();
  await expect(
    page.getByText(
      'Exact request reconciled. Refresh history before another change.',
    ),
  ).toBeVisible();
  expect(state.writes[1]).toEqual({ ...original, csrf: state.csrf });
});
for (const change of ['company', 'actor', 'role'] as const) {
  test(`mapping workspace will not retry uncertain writes after ${change} changes`, async ({
    page,
  }) => {
    const state = await mappingFixture(page);
    state.writeStatus = 503;
    await page.goto('/device-mappings');
    await fillMapping(page);
    await page
      .getByRole('button', { name: 'Create employee mapping', exact: true })
      .click();
    await expect(page.getByText(/Outcome unknown/)).toBeVisible();
    if (change === 'company') state.selected = mappingEmployeeId;
    if (change === 'actor') state.identity = mappingEmployeeId;
    if (change === 'role') state.roles = ['hr_admin'];
    await page
      .getByRole('button', { name: 'Retry exact mapping request' })
      .click();
    await expect(
      page.getByText(/Mapping access denied or context changed/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry exact mapping request' }),
    ).toHaveCount(0);
    expect(state.writes).toHaveLength(1);
  });
}
test('mapping workspace rejects stale commands and invalid receipts until fresh metadata is loaded', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.writeStatus = 409;
  await page.goto('/device-mappings');
  await fillMapping(page);
  await page
    .getByRole('button', { name: 'Create employee mapping', exact: true })
    .click();
  await expect(page.getByText(/Change rejected/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create employee mapping', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Retry exact mapping request' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  state.writeStatus = 201;
  state.badReceipt = true;
  await fillMapping(page);
  await page
    .getByRole('button', { name: 'Create employee mapping', exact: true })
    .click();
  await expect(page.getByText(/Outcome unknown/)).toBeVisible();
  expect(state.writes).toHaveLength(2);
});
test('mapping workspace clears company data and forms on denied reads and rejects wrong-company lists', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.rows = [mappingHistory()];
  await page.goto('/device-mappings');
  await fillMapping(page);
  state.readStatus = 403;
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(page.getByText(/Mapping access denied/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Source ID 0007' }),
  ).toHaveCount(0);
  state.readStatus = 200;
  state.badList = true;
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(
    page.getByText(/Mapping data is unavailable or invalid/),
  ).toBeVisible();
  state.badList = false;
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(page.getByLabel('Source user ID', { exact: true })).toHaveValue(
    '',
  );
});
test('mapping workspace paginates bounded device and mapping history without mixing device scopes', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.devices = Array.from({ length: 26 }, (_, i) => inventoryRow(i + 1));
  state.rows = Array.from({ length: 26 }, (_, i) => ({
    ...mappingHistory(701 + i),
    sourceUserId: String(i + 1),
  }));
  state.rows.push({
    ...mappingHistory(801),
    deviceId: inventoryRow(26).id,
    sourceUserId: 'other-device',
  });
  await page.goto('/device-mappings');
  await expect(
    page.getByRole('heading', { name: 'Source ID 1', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next mappings page' }).click();
  await expect(
    page.getByRole('heading', { name: 'Source ID 26', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Source ID 1', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Next devices page' }).click();
  await expect(
    page.getByRole('heading', { name: 'Source ID other-device', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Source ID 26', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'First devices page' }).click();
  await expect(
    page.getByRole('heading', { name: 'Source ID 1', exact: true }),
  ).toBeVisible();
});
for (const status of ['unmapped', 'ambiguous']) {
  test(`mapping workspace displays ${status} without an employee guess and clears lookup after input edits`, async ({
    page,
  }) => {
    const state = await mappingFixture(page);
    state.roles = ['hr_admin'];
    state.resolveStatus = status;
    await page.goto('/device-mappings');
    await page.getByLabel('Lookup source ID', { exact: true }).fill('0007');
    await page
      .getByLabel('Event instant (UTC or explicit offset)', { exact: true })
      .fill('2026-10-02T00:00:00Z');
    await page
      .getByRole('button', { name: 'Resolve employee mapping', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'no employee is guessed',
    );
    await page.getByLabel('Lookup source ID', { exact: true }).fill('0008');
    await expect(page.getByRole('status')).toHaveCount(0);
  });
}
test('mapping workspace rejects invalid inputs locally and excludes archived employees', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.employees.push({
    ...state.employees[0],
    id: '00000000-0000-4000-8000-000000000602',
    status: 'archived',
    name: 'Synthetic Archived',
    archivedAt: '2026-10-01T00:00:00Z',
  });
  await page.goto('/device-mappings');
  await fillMapping(page);
  await expect(
    page.getByRole('option', { name: /Synthetic Archived/ }),
  ).toHaveCount(0);
  await page.getByLabel('Source user ID', { exact: true }).fill(' 0007');
  await page
    .getByRole('button', { name: 'Create employee mapping', exact: true })
    .click();
  await expect(
    page.getByText(/Enter an exact source ID and valid offset timestamps/),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
});
test('mapping workspace handles signed-out, unselected, unauthorized and empty device states', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.sessionStatus = 401;
  await page.goto('/device-mappings');
  await expect(
    page.getByText('Sign in to view device mappings.', { exact: true }),
  ).toBeVisible();
  state.sessionStatus = 200;
  state.selected = null;
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(
    page.getByText(/Select a company before viewing device mappings/),
  ).toBeVisible();
  state.selected = deviceTenant;
  state.roles = ['employee'];
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(page.getByText(/Mapping access denied/)).toBeVisible();
  state.roles = ['owner'];
  state.devices = [];
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(page.getByText(/No devices on this page/)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Create mapping' })).toHaveCount(
    0,
  );
});

test('mapping workspace can retry an undispatched enrollment-free write as its first execution', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  let firstRequest = true;
  let original: { key: string; body: unknown } | null = null;
  await page.route('**/employee-mappings', async (route) => {
    if (route.request().method() === 'POST' && firstRequest) {
      firstRequest = false;
      original = {
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      };
      await route.abort('failed');
    } else await route.fallback();
  });
  await page.goto('/device-mappings');
  await fillMapping(page);
  await page
    .getByRole('button', { name: 'Create employee mapping', exact: true })
    .click();
  await expect(page.getByText(/Outcome unknown/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Retry exact mapping request' })
    .click();
  await expect(
    page.getByText('Change confirmed. Refresh history before another change.'),
  ).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect({ key: state.writes[0].key, body: state.writes[0].body }).toEqual(
    original,
  );
});
test('mapping workspace refuses a different mapping ID in an end receipt', async ({
  page,
}) => {
  const state = await mappingFixture(page);
  state.rows = [mappingHistory()];
  await page.route('**/employee-mappings/*/end', (route) =>
    route.fulfill({
      status: 201,
      json: { id: mappingEmployeeId, version: 2, replayed: false },
    }),
  );
  await page.goto('/device-mappings');
  await page
    .getByRole('combobox', { name: 'Mapping to end', exact: true })
    .selectOption(mappingHistory().id);
  await page
    .getByLabel('New exclusive end (UTC or explicit offset)', { exact: true })
    .fill('2026-10-02T00:00:00Z');
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('button', { name: 'End employee mapping', exact: true })
    .click();
  await expect(page.getByText(/Outcome unknown/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry exact mapping request' }),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'End mapping' })).toHaveCount(0);
});
test('mapping workspace fails closed on duplicate history and malformed next cursors', async ({
  page,
}) => {
  await mappingFixture(page);
  let duplicate = false;
  await page.route('**/employee-mappings?**', (route) =>
    route.fulfill({
      json: {
        tenantId: deviceTenant,
        deviceId: inventoryRow().id,
        items: duplicate
          ? [mappingHistory(), mappingHistory()]
          : [mappingHistory()],
        nextCursor: duplicate ? null : mappingHistory().id,
        attendanceProcessingAvailable: false,
      },
    }),
  );
  await page.goto('/device-mappings');
  await expect(
    page.getByText(/Mapping data is unavailable or invalid/),
  ).toBeVisible();
  duplicate = true;
  await page.getByRole('button', { name: 'Refresh mapping metadata' }).click();
  await expect(
    page.getByText(/Mapping data is unavailable or invalid/),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Source ID 0007' }),
  ).toHaveCount(0);
});
