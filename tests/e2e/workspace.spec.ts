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

test('HR creates and explicitly activates a complete monthly-salaried employee', async ({
  page,
}) => {
  const tenantId = '9d2ea3ef-3938-42d0-84f9-d2248f692f67';
  const employeeId = '44c4bf77-58bb-42ea-9886-5db47c1c3de5';
  const branchId = '82ffbc9e-febd-4a62-bdaf-fd8740ee6982';
  const departmentId = 'eb071d7d-89e8-493a-b5b7-3edaf41d4ae3';
  const designationId = '5fa15252-0934-4abe-8074-67b764424d65';
  const assignmentId = '2415cafa-d6dc-45ae-8b50-4cd2d0035cdd';
  const csrf = 'b'.repeat(43);
  const joiningDate = '2026-09-08';
  const employees: Record<string, unknown>[] = [];
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
        selectedTenantId: tenantId,
        tenants: [
          { id: tenantId, name: 'Synthetic Company', roles: ['hr_admin'] },
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
    `**/api/v1/tenants/${tenantId}/employees/${employeeId}/activate`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrf);
      expect(route.request().postDataJSON()).toEqual({
        expectedVersion: 1,
        reason: 'Approved employee activation',
      });
      Object.assign(employees[0], { status: 'active', version: 2 });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: employeeId, version: 2, status: 'active' }),
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
  await expect(
    page.getByText(/Salary, CNIC, bank and emergency details/),
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
