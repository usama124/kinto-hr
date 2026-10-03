import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { PrismaClient } from '@kinto/database';

const roles = [
  'kinto_app',
  'kinto_worker',
  'kinto_dispatcher',
  'kinto_control_owner',
  'kinto_outbox_owner',
] as const;
type Role = (typeof roles)[number];
type Scope =
  | 'tenant'
  | 'tenant-control'
  | 'identity'
  | 'platform-control'
  | 'platform-catalog';
type Privilege =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'TRUNCATE'
  | 'REFERENCES'
  | 'TRIGGER';
type Policy = {
  name: string;
  command: string;
  roles: string[];
  permissive: boolean;
  using: string | null;
  check: string | null;
};
type Classification = {
  name: string;
  scope: Scope;
  tenantColumn: 'id' | 'tenant_id' | null;
  policies: Policy[];
  grants: Partial<Record<Role, Privilege[]>>;
  columnGrants?: { role: Role; privilege: Privilege; columns: string[] }[];
  regression: { file: string; scenario: string };
};
const tenantExpression = (column: string) =>
  `(${column} = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`;
const policy = (
  name: string,
  command: string,
  role: string,
  using: string | null,
  check: string | null,
): Policy => ({ name, command, roles: [role], permissive: true, using, check });
const tenantPolicy = (column = 'tenant_id', command = '*') =>
  policy(
    'tenant_scope',
    command,
    'PUBLIC',
    tenantExpression(column),
    command === '*' ? tenantExpression(column) : null,
  );
const controlPolicy = policy(
  'platform_control',
  '*',
  'kinto_control_owner',
  'true',
  'true',
);
const controlSelect = policy(
  'platform_control_select',
  'r',
  'kinto_control_owner',
  'true',
  null,
);
const controlInsert = policy(
  'platform_control_insert',
  'a',
  'kinto_control_owner',
  null,
  'true',
);
const controlCrud: Privilege[] = ['SELECT', 'INSERT', 'UPDATE'];
const controlAppend: Privilege[] = ['SELECT', 'INSERT'];
const regression = (file: string, scenario: string) => ({
  file: `tests/integration/${file}.test.ts`,
  scenario,
});
const tenantTable = (
  name: string,
  test: Classification['regression'],
  grants: Classification['grants'] = { kinto_control_owner: controlCrud },
): Classification => ({
  name,
  scope: 'tenant',
  tenantColumn: 'tenant_id',
  policies: [tenantPolicy(), controlPolicy],
  grants,
  regression: test,
});
const privateTenantTable = (
  name: string,
  test: Classification['regression'],
  grants: Classification['grants'] = { kinto_control_owner: controlCrud },
): Classification => ({
  name,
  scope: 'tenant-control',
  tenantColumn: 'tenant_id',
  policies: [controlPolicy],
  grants,
  regression: test,
});
const employeeRecord = (scenario: string) =>
  regression('employee-records', scenario);
const entitlement = (scenario: string) =>
  regression('entitlement-controls', scenario);
const organization = (scenario: string) =>
  regression('organization-policies', scenario);
const employeeAccount = regression(
  'employee-account-provisioning',
  'keeps the request table private and uses the constrained function owner',
);
const administratorAccount = regression(
  'administrator-invitations',
  'keeps tables private and exposes only constrained control functions',
);
const platformAccount = regression(
  'platform-provisioning',
  'denies ordinary identities, missing MFA, and all direct runtime writes',
);
const worker = regression(
  'worker',
  'fails closed without context and cannot consume a different tenant event',
);
const imports = regression(
  'employee-import-preview',
  'denies missing MFA, payroll-only and cross-tenant preview access',
);

// Reviewed expectations, not inferred from the live catalog. Each new table must
// declare its boundary and a scenario in an executed integration test suite.
export const schemaIsolationInventory: readonly Classification[] = [
  privateTenantTable('administrator_account_requests', administratorAccount),
  privateTenantTable('administrator_invitations', administratorAccount),
  {
    name: 'audit_events',
    scope: 'tenant',
    tenantColumn: 'tenant_id',
    policies: [tenantPolicy(), controlSelect, controlInsert],
    grants: { kinto_app: controlAppend, kinto_control_owner: controlAppend },
    regression: regression(
      'security-audit',
      'denies non-owners, stale MFA, cross-tenant access and cross-tenant cursors',
    ),
  },
  tenantTable(
    'branches',
    organization(
      'creates tenant branches and protects an effective or future default from deactivation',
    ),
  ),
  tenantTable(
    'checklist_tasks',
    employeeRecord(
      'versions tenant-scoped onboarding tasks without exposing workflow writes to payroll',
    ),
  ),
  tenantTable(
    'company_policy_versions',
    organization(
      'rejects stale publication, cross-tenant branch settings and direct runtime table access',
    ),
  ),
  privateTenantTable('company_provisioning_requests', platformAccount),
  tenantTable(
    'compensation_agreements',
    employeeRecord(
      'retains effective compensation revisions behind explicit payroll roles',
    ),
  ),
  tenantTable(
    'compensation_component_versions',
    employeeRecord(
      'retains effective compensation revisions behind explicit payroll roles',
    ),
  ),
  {
    name: 'consumer_receipts',
    scope: 'tenant',
    tenantColumn: 'tenant_id',
    policies: [tenantPolicy()],
    grants: { kinto_worker: controlAppend },
    regression: worker,
  },
  tenantTable(
    'departments',
    organization(
      'versions tenant-scoped department and designation catalogs with owner-only writes',
    ),
  ),
  tenantTable(
    'designations',
    organization(
      'versions tenant-scoped department and designation catalogs with owner-only writes',
    ),
  ),
  privateTenantTable('employee_account_requests', employeeAccount),
  tenantTable(
    'employee_assignments',
    employeeRecord(
      'appends assignment history and rejects direct or indirect reporting cycles',
    ),
  ),
  tenantTable(
    'employee_documents',
    employeeRecord(
      'registers isolated retry-safe document metadata without exposing storage secrets',
    ),
  ),
  privateTenantTable('employee_identity_links', employeeAccount, {
    kinto_control_owner: controlAppend,
  }),
  tenantTable('employee_import_batches', imports),
  tenantTable('employee_import_rows', imports),
  privateTenantTable('employee_invitations', employeeAccount),
  tenantTable(
    'employee_private_details',
    employeeRecord(
      'isolates versioned private details behind owner/HR permission and recent MFA',
    ),
  ),
  tenantTable(
    'employee_profile_change_requests',
    employeeRecord(
      'shows only own clean employee-visible documents through an active identity link',
    ),
  ),
  tenantTable(
    'employees',
    regression(
      'database',
      'isolates identical employee numbers and rejects cross-tenant writes',
    ),
    { kinto_app: controlCrud, kinto_control_owner: controlCrud },
  ),
  tenantTable(
    'employment_periods',
    employeeRecord(
      'creates complete tenant-scoped drafts and exposes no private or salary fields',
    ),
  ),
  tenantTable(
    'entitlement_creation_receipts',
    entitlement(
      'scopes receipts by company, rejects changed fields and does not reserve refused requests',
    ),
    { kinto_control_owner: controlAppend },
  ),
  tenantTable(
    'entitlement_grants',
    entitlement(
      'requires an active recent-MFA operator and revokes immutably with audit reasons',
    ),
    { kinto_app: ['SELECT'], kinto_control_owner: controlCrud },
  ),
  tenantTable(
    'entitlement_overrides',
    entitlement(
      'gives an employee-limit override precedence and rejects overlapping active overrides',
    ),
    { kinto_app: ['SELECT'], kinto_control_owner: controlCrud },
  ),
  tenantTable(
    'entitlement_revocation_receipts',
    entitlement(
      'scopes revocation receipts by company and actor, and rechecks authority on replay',
    ),
    { kinto_control_owner: controlAppend },
  ),
  {
    name: 'identities',
    scope: 'identity',
    tenantColumn: null,
    policies: [
      policy(
        'identity_scope',
        'r',
        'PUBLIC',
        "(((issuer)::text = NULLIF(current_setting('app.identity_issuer'::text, true), ''::text)) AND ((subject)::text = NULLIF(current_setting('app.identity_subject'::text, true), ''::text)))",
        null,
      ),
      controlSelect,
      controlInsert,
    ],
    grants: { kinto_app: ['SELECT'], kinto_control_owner: controlAppend },
    regression: regression(
      'access',
      'matches the issuer and subject exactly, without implicit identity or company creation',
    ),
  },
  {
    name: 'job_deliveries',
    scope: 'tenant',
    tenantColumn: 'tenant_id',
    policies: [
      tenantPolicy(),
      policy('outbox_control', '*', 'kinto_outbox_owner', 'true', 'true'),
    ],
    grants: { kinto_worker: ['SELECT'], kinto_outbox_owner: controlAppend },
    columnGrants: [
      {
        role: 'kinto_worker',
        privilege: 'UPDATE',
        columns: [
          'status',
          'attempts',
          'available_at',
          'last_error',
          'completed_at',
        ],
      },
    ],
    regression: worker,
  },
  tenantTable(
    'legal_entities',
    organization(
      'audits legal identity changes and enforces version and tenant boundaries',
    ),
  ),
  {
    name: 'memberships',
    scope: 'tenant',
    tenantColumn: 'tenant_id',
    policies: [
      policy(
        'membership_scope',
        'r',
        'PUBLIC',
        "((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (EXISTS ( SELECT 1 FROM identities WHERE (identities.id = memberships.identity_id))))",
        null,
      ),
      controlPolicy,
    ],
    grants: { kinto_app: ['SELECT'], kinto_control_owner: controlCrud },
    regression: regression(
      'access',
      'rejects a tenant selector without membership before invoking any work',
    ),
  },
  {
    name: 'outbox_events',
    scope: 'tenant',
    tenantColumn: 'tenant_id',
    policies: [tenantPolicy(), controlInsert],
    grants: {
      kinto_app: controlAppend,
      kinto_worker: ['SELECT'],
      kinto_control_owner: ['INSERT'],
    },
    regression: worker,
  },
  privateTenantTable('owner_invitations', platformAccount),
  {
    name: 'plan_versions',
    scope: 'platform-catalog',
    tenantColumn: null,
    policies: [
      policy('catalog_denied', '*', 'PUBLIC', 'false', 'false'),
      policy('platform_control', 'r', 'kinto_control_owner', 'true', null),
    ],
    grants: { kinto_control_owner: ['SELECT'] },
    regression: regression(
      'entitlements',
      'seeds five price-free immutable plan versions and denies direct runtime catalog access',
    ),
  },
  {
    name: 'platform_audit_events',
    scope: 'platform-control',
    tenantColumn: null,
    policies: [controlInsert],
    grants: { kinto_control_owner: ['INSERT'] },
    regression: platformAccount,
  },
  {
    name: 'platform_operators',
    scope: 'platform-control',
    tenantColumn: null,
    policies: [controlSelect],
    grants: { kinto_control_owner: ['SELECT'] },
    regression: platformAccount,
  },
  tenantTable(
    'salary_components',
    employeeRecord(
      'retains effective compensation revisions behind explicit payroll roles',
    ),
  ),
  tenantTable(
    'tenant_entitlement_states',
    entitlement(
      'requires an active recent-MFA operator and revokes immutably with audit reasons',
    ),
  ),
  tenantTable(
    'tenant_subscriptions',
    regression(
      'entitlements',
      'returns the effective base subscription only to recent-MFA owners and HR',
    ),
    { kinto_app: ['SELECT'], kinto_control_owner: controlCrud },
  ),
  {
    name: 'tenants',
    scope: 'tenant',
    tenantColumn: 'id',
    policies: [tenantPolicy('id', 'r'), controlPolicy],
    grants: {
      kinto_app: ['SELECT'],
      kinto_worker: ['SELECT'],
      kinto_control_owner: controlAppend,
    },
    regression: regression('database', 'fails closed without tenant context'),
  },
  tenantTable(
    'workforce_report_exports',
    regression(
      'workforce-report-exports',
      'binds idempotency content and denies roles, stale MFA and other tenants',
    ),
  ),
];

type CatalogTable = {
  name: string;
  kind: string;
  enabled: boolean;
  forced: boolean;
  tenantColumn: string | null;
  tenantType: string | null;
  tenantNotNull: boolean | null;
  policies: Policy[];
};
const normalizePolicy = (value: Policy) => ({
  ...value,
  roles: [...value.roles].sort(),
  using: value.using?.replace(/\s+/g, ' ').trim() ?? null,
  check: value.check?.replace(/\s+/g, ' ').trim() ?? null,
});

export async function validateIsolationInventory(
  inventory: readonly Classification[] = schemaIsolationInventory,
) {
  assert.equal(
    new Set(inventory.map(({ name }) => name)).size,
    inventory.length,
    'Duplicate table classification',
  );
  for (const table of inventory) {
    assert.ok(
      [
        'tenant',
        'tenant-control',
        'identity',
        'platform-control',
        'platform-catalog',
      ].includes(table.scope),
      `Invalid scope: ${table.name}`,
    );
    assert.equal(
      table.tenantColumn !== null,
      ['tenant', 'tenant-control'].includes(table.scope),
      `Missing tenant classification: ${table.name}`,
    );
    assert.match(
      table.regression.file,
      /^tests\/integration\/[a-z-]+\.test\.ts$/,
    );
    const source = await readFile(table.regression.file, 'utf8');
    assert.ok(
      source.includes(`it('${table.regression.scenario}',`),
      `Missing regression scenario: ${table.name}`,
    );
  }
}

export async function verifySchemaIsolation(
  db: Pick<PrismaClient, '$queryRaw'>,
) {
  await validateIsolationInventory();
  const tables = await db.$queryRaw<CatalogTable[]>`
    SELECT c.relname AS name, c.relkind::text AS kind,
      c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
      a.attname AS "tenantColumn", format_type(a.atttypid,a.atttypmod) AS "tenantType",
      a.attnotnull AS "tenantNotNull",
      coalesce((SELECT json_agg(json_build_object(
        'name',p.polname,'command',p.polcmd::text,'permissive',p.polpermissive,
        'roles',(SELECT json_agg(CASE WHEN role_id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id) END ORDER BY role_id) FROM unnest(p.polroles) role_id),
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)
      ) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::json) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=CASE WHEN c.relname='tenants' THEN 'id' ELSE 'tenant_id' END AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p','f') AND c.relname<>'_prisma_migrations'
    ORDER BY c.relname`;
  assert.deepEqual(
    tables.map(({ name }) => name),
    schemaIsolationInventory.map(({ name }) => name).sort(),
    'Unclassified or missing business table',
  );
  const roleRows = await db.$queryRaw<{ name: string; safe: boolean }[]>`
    SELECT r.rolname AS name, NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolcanlogin <> (r.rolname IN ('kinto_app','kinto_worker','kinto_dispatcher')) OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)) AS safe
    FROM pg_roles r WHERE r.rolname IN ('kinto_app','kinto_worker','kinto_dispatcher','kinto_control_owner','kinto_outbox_owner') ORDER BY r.rolname`;
  assert.deepEqual(
    roleRows.map(({ name }) => name),
    [...roles].sort(),
    'Missing isolation role',
  );
  for (const role of roleRows)
    assert.ok(role.safe, `Unsafe isolation role: ${role.name}`);
  const privileges = await db.$queryRaw<
    {
      table: string;
      role: Role;
      privilege: Privilege;
      granted: boolean;
    }[]
  >`
    SELECT c.relname AS "table", r.rolname AS role, v.privilege,
      has_table_privilege(r.oid,c.oid,v.privilege) AS granted
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v(privilege)
    WHERE n.nspname='public' AND c.relkind IN ('r','p','f') AND c.relname<>'_prisma_migrations'
      AND r.rolname IN ('kinto_app','kinto_worker','kinto_dispatcher','kinto_control_owner','kinto_outbox_owner')`;
  const columnPrivileges = await db.$queryRaw<
    { table: string; role: Role; privilege: Privilege; column: string }[]
  >`
    SELECT c.relname AS "table", r.rolname AS role, v.privilege, a.attname AS "column"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) v(privilege)
    WHERE n.nspname='public' AND c.relkind IN ('r','p','f') AND c.relname<>'_prisma_migrations'
      AND r.rolname IN ('kinto_app','kinto_worker','kinto_dispatcher','kinto_control_owner','kinto_outbox_owner')
      AND NOT has_table_privilege(r.oid,c.oid,v.privilege)
      AND has_column_privilege(r.oid,c.oid,a.attnum,v.privilege)`;
  for (const table of tables) {
    const expected = schemaIsolationInventory.find(
      ({ name }) => name === table.name,
    )!;
    assert.deepEqual(
      { kind: table.kind, enabled: table.enabled, forced: table.forced },
      { kind: 'r', enabled: true, forced: true },
      `RLS boundary mismatch: ${table.name}`,
    );
    assert.equal(
      table.tenantColumn,
      expected.tenantColumn,
      `Tenant column mismatch: ${table.name}`,
    );
    if (expected.tenantColumn) {
      assert.equal(
        table.tenantType,
        'uuid',
        `Tenant column type mismatch: ${table.name}`,
      );
      assert.equal(
        table.tenantNotNull,
        true,
        `Nullable tenant column: ${table.name}`,
      );
    }
    assert.deepEqual(
      table.policies
        .map(normalizePolicy)
        .sort((a, b) => a.name.localeCompare(b.name)),
      expected.policies
        .map(normalizePolicy)
        .sort((a, b) => a.name.localeCompare(b.name)),
      `Policy boundary mismatch: ${table.name}`,
    );
    for (const privilege of privileges.filter(
      (entry) => entry.table === table.name,
    )) {
      const granted =
        expected.grants[privilege.role]?.includes(privilege.privilege) ?? false;
      assert.equal(
        privilege.granted,
        granted,
        `Table privilege mismatch: ${table.name}/${privilege.role}/${privilege.privilege}`,
      );
    }
    const actualColumns = columnPrivileges
      .filter((entry) => entry.table === table.name)
      .map(({ role, privilege, column }) => `${role}/${privilege}/${column}`)
      .sort();
    const expectedColumns = (expected.columnGrants ?? [])
      .flatMap(({ role, privilege, columns }) =>
        columns.map((column) => `${role}/${privilege}/${column}`),
      )
      .sort();
    assert.deepEqual(
      actualColumns,
      expectedColumns,
      `Column privilege mismatch: ${table.name}`,
    );
  }
  return tables.length;
}
