import { existsSync } from 'node:fs';
import { createDatabase } from '@kinto/database';
import { verifySchemaIsolation } from './schema-isolation';

if (existsSync('.env')) process.loadEnvFile('.env');
async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !new URL(url).pathname.startsWith('/kinto_test'))
    throw new Error(
      'Schema isolation verification requires a synthetic kinto_test database',
    );
  const db = createDatabase(url);
  try {
    const count = await verifySchemaIsolation(db);
    console.log(
      `Schema isolation classification passed for ${count} business tables.`,
    );
  } finally {
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Schema isolation verification failed',
  );
  process.exitCode = 1;
});
