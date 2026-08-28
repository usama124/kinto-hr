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
    'GRANT SELECT, INSERT, UPDATE ON employees TO kinto_app',
  );
  await database.$executeRawUnsafe(
    'GRANT SELECT, INSERT ON audit_events, outbox_events TO kinto_app',
  );
  await assertSafeRuntimeRole(appDatabase);
  console.log(
    'Local runtime role provisioned and verified. No customer data seeded.',
  );
} finally {
  await database.$disconnect();
  await appDatabase.$disconnect();
}
