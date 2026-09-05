import { existsSync } from 'node:fs';
import { createDatabase, assertSafeRuntimeRole } from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!migrationUrl || !runtimeUrl)
  throw new Error('Both database URLs are required');
const admin = new URL(migrationUrl);
const runtime = new URL(runtimeUrl);
if (
  !['localhost', '127.0.0.1'].includes(admin.hostname) ||
  !admin.pathname.startsWith('/kinto_') ||
  admin.host !== runtime.host ||
  admin.pathname !== runtime.pathname ||
  runtime.username !== 'kinto_app' ||
  admin.username === runtime.username
) {
  throw new Error(
    'Bootstrap requires a local kinto_* database and separate kinto_app role',
  );
}
const password = decodeURIComponent(runtime.password);
if (password.length < 16)
  throw new Error('Runtime password must be at least 16 characters');
const database = createDatabase(migrationUrl);
const appDatabase = createDatabase(runtimeUrl);
try {
  const roles = await database.$queryRaw<
    { rolname: string }[]
  >`SELECT rolname FROM pg_roles WHERE rolname = 'kinto_app'`;
  // Role DDL cannot bind passwords. The role is fixed; escape the local operator's literal.
  const quoted = "'" + password.replaceAll("'", "''") + "'";
  if (roles.length === 0)
    await database.$executeRawUnsafe(
      `CREATE ROLE kinto_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quoted}`,
    );
  else
    await database.$executeRawUnsafe(`ALTER ROLE kinto_app PASSWORD ${quoted}`);
  await database.$executeRawUnsafe(
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
  );
  await database.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO kinto_app');
  await database.$executeRawUnsafe(
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kinto_app',
  );
  await database.$executeRawUnsafe('GRANT SELECT ON tenants TO kinto_app');
  await database.$executeRawUnsafe(
    'GRANT SELECT ON identities, memberships TO kinto_app',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT, UPDATE ON employees TO kinto_app',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT ON audit_events, outbox_events TO kinto_app',
  );
  // Company provisioning is a reviewed SECURITY DEFINER operation. Its owner
  // cannot log in or bypass RLS and receives only the columns/tables it needs.
  await database.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinto_control_owner') THEN
      CREATE ROLE kinto_control_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinto_control_owner' AND
      (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
      OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid, m.member)
        WHERE r.rolname = 'kinto_control_owner') THEN
      RAISE EXCEPTION 'Unsafe control-plane function owner';
    END IF;
  END $$`);
  await database.$executeRawUnsafe(
    'GRANT USAGE ON SCHEMA public TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kinto_control_owner',
  );
  for (const statement of [
    'DROP POLICY IF EXISTS platform_control_select ON identities',
    'CREATE POLICY platform_control_select ON identities FOR SELECT TO kinto_control_owner USING (true)',
    'DROP POLICY IF EXISTS platform_control_insert ON identities',
    'CREATE POLICY platform_control_insert ON identities FOR INSERT TO kinto_control_owner WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control_select ON platform_operators',
    'CREATE POLICY platform_control_select ON platform_operators FOR SELECT TO kinto_control_owner USING (true)',
    'DROP POLICY IF EXISTS platform_control ON tenants',
    'CREATE POLICY platform_control ON tenants FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON company_provisioning_requests',
    'CREATE POLICY platform_control ON company_provisioning_requests FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON owner_invitations',
    'CREATE POLICY platform_control ON owner_invitations FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON memberships',
    'CREATE POLICY platform_control ON memberships FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control_select ON employees',
    'CREATE POLICY platform_control_select ON employees FOR SELECT TO kinto_control_owner USING (true)',
    'DROP POLICY IF EXISTS platform_control ON employee_account_requests',
    'CREATE POLICY platform_control ON employee_account_requests FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON employee_invitations',
    'CREATE POLICY platform_control ON employee_invitations FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON employee_identity_links',
    'CREATE POLICY platform_control ON employee_identity_links FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON administrator_account_requests',
    'CREATE POLICY platform_control ON administrator_account_requests FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control ON administrator_invitations',
    'CREATE POLICY platform_control ON administrator_invitations FOR ALL TO kinto_control_owner USING (true) WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control_insert ON audit_events',
    'CREATE POLICY platform_control_insert ON audit_events FOR INSERT TO kinto_control_owner WITH CHECK (true)',
    'DROP POLICY IF EXISTS platform_control_insert ON platform_audit_events',
    'CREATE POLICY platform_control_insert ON platform_audit_events FOR INSERT TO kinto_control_owner WITH CHECK (true)',
  ])
    await database.$executeRawUnsafe(statement);
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT ON identities TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT ON platform_operators TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT ON tenants TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT, UPDATE ON company_provisioning_requests, owner_invitations TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT, UPDATE ON memberships TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT ON employees TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT, UPDATE ON employee_account_requests, employee_invitations TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT ON employee_identity_links TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT, UPDATE ON administrator_account_requests, administrator_invitations TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT INSERT ON audit_events, platform_audit_events TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'ALTER FUNCTION public.request_company_provisioning(uuid, boolean, uuid, uuid, uuid, uuid, uuid, varchar, integer, varchar, varchar) OWNER TO kinto_control_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT EXECUTE ON FUNCTION public.request_company_provisioning(uuid, boolean, uuid, uuid, uuid, uuid, uuid, varchar, integer, varchar, varchar) TO kinto_app',
  );
  for (const signature of [
    'public.reconcile_company_owner_provider(uuid, uuid, uuid, varchar, varchar, timestamptz, uuid, uuid)',
    'public.mark_company_owner_invitation_delivered(uuid, timestamptz, uuid, uuid)',
    'public.resolve_login_identity(varchar, varchar, boolean, uuid, uuid, uuid, uuid, uuid)',
    'public.request_employee_account_provisioning(uuid, boolean, uuid, uuid, uuid, uuid, uuid, varchar)',
    'public.reconcile_employee_account_provider(uuid, uuid, uuid, varchar, varchar, timestamptz, uuid)',
    'public.mark_employee_invitation_delivered(uuid, timestamptz, uuid)',
    'public.list_tenant_memberships(uuid, boolean, uuid)',
    'public.mutate_tenant_membership(uuid, boolean, uuid, uuid, integer, text[], boolean, varchar, uuid)',
    'public.request_administrator_invitation(uuid, boolean, uuid, uuid, uuid, uuid, varchar, text[], varchar)',
    'public.reconcile_administrator_invitation_provider(uuid, uuid, uuid, varchar, varchar, timestamptz, uuid)',
    'public.mark_administrator_invitation_delivered(uuid, timestamptz, uuid)',
    'public.discover_identity_tenants(uuid)',
  ]) {
    await database.$executeRawUnsafe(
      `ALTER FUNCTION ${signature} OWNER TO kinto_control_owner`,
    );
    await database.$executeRawUnsafe(
      `GRANT EXECUTE ON FUNCTION ${signature} TO kinto_app`,
    );
  }
  for (const signature of [
    'public.resolve_login_identity_pre_administrator(varchar, varchar, boolean, uuid, uuid, uuid, uuid, uuid)',
    'public.enforce_one_pending_identity_invitation()',
  ])
    await database.$executeRawUnsafe(
      `ALTER FUNCTION ${signature} OWNER TO kinto_control_owner`,
    );
  await assertSafeRuntimeRole(appDatabase);
  // The dispatcher can call reviewed metadata functions only. The worker has
  // tenant-scoped delivery access, but no employee, salary or audit privileges.
  for (const [role, envKey] of [
    ['kinto_worker', 'WORKER_DATABASE_URL'],
    ['kinto_dispatcher', 'DISPATCHER_DATABASE_URL'],
  ] as const) {
    const value = process.env[envKey];
    if (!value) throw new Error(`${envKey} is required`);
    const target = new URL(value);
    if (
      target.username !== role ||
      target.host !== admin.host ||
      target.pathname !== admin.pathname ||
      !['postgres:', 'postgresql:'].includes(target.protocol) ||
      decodeURIComponent(target.password).length < 16
    )
      throw new Error(`Invalid local ${envKey}`);
    const found = await database.$queryRaw<
      { rolname: string }[]
    >`SELECT rolname FROM pg_roles WHERE rolname = ${role}`;
    const literal =
      "'" + decodeURIComponent(target.password).replaceAll("'", "''") + "'";
    if (found.length === 0)
      await database.$executeRawUnsafe(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${literal}`,
      );
    else
      await database.$executeRawUnsafe(
        `ALTER ROLE ${role} PASSWORD ${literal}`,
      );
    await database.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await database.$executeRawUnsafe(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`,
    );
    const check = createDatabase(value);
    try {
      await assertSafeRuntimeRole(check);
    } finally {
      await check.$disconnect();
    }
  }
  await database.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinto_outbox_owner') THEN
      CREATE ROLE kinto_outbox_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinto_outbox_owner' AND
      (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
      OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid, m.member)
        WHERE r.rolname = 'kinto_outbox_owner') THEN
      RAISE EXCEPTION 'Unsafe outbox function owner';
    END IF;
  END $$`);
  await database.$executeRawUnsafe(
    'GRANT USAGE ON SCHEMA public TO kinto_outbox_owner',
  );
  await database.$executeRawUnsafe(
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kinto_outbox_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT ON job_deliveries TO kinto_outbox_owner',
  );
  await database.$executeRawUnsafe(
    'DROP POLICY IF EXISTS outbox_control ON job_deliveries',
  );
  await database.$executeRawUnsafe(
    'CREATE POLICY outbox_control ON job_deliveries TO kinto_outbox_owner USING (true) WITH CHECK (true)',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT ON tenants, outbox_events, job_deliveries, consumer_receipts TO kinto_worker',
  );
  await database.$executeRawUnsafe(
    'GRANT UPDATE (status, attempts, available_at, last_error, completed_at) ON job_deliveries TO kinto_worker',
  );
  await database.$executeRawUnsafe(
    'GRANT INSERT ON consumer_receipts TO kinto_worker',
  );
  await database.$executeRawUnsafe(
    'ALTER FUNCTION public.enqueue_outbox_delivery() OWNER TO kinto_outbox_owner',
  );
  await database.$executeRawUnsafe(
    'ALTER FUNCTION public.pending_outbox(integer) OWNER TO kinto_outbox_owner',
  );
  await database.$executeRawUnsafe(
    'ALTER FUNCTION public.outbox_health() OWNER TO kinto_outbox_owner',
  );
  await database.$executeRawUnsafe(
    'GRANT EXECUTE ON FUNCTION public.pending_outbox(integer), public.outbox_health() TO kinto_dispatcher',
  );
  console.log(
    'Local runtime role provisioned and verified. No customer data seeded.',
  );
} finally {
  await database.$disconnect();
  await appDatabase.$disconnect();
}
