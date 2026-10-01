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
  await expect(page.getByText(/Salary and bank details remain/)).toBeVisible();
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

test('operator entitlement uncertainty blocks retries and history fails closed', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const fixture = operatorEntitlementFixture(tenantId);
  let mutationStatus = 409;
  let creates = 0;
  let stateStatus = 200;
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
      return route.fulfill({ status: mutationStatus, json: {} });
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
  stateStatus = 404;
  await page
    .getByRole('button', { name: 'Refresh entitlement history' })
    .click();
  await expect(page.getByRole('main')).toHaveText(
    'An active company with a current subscription is required.',
  );
});
