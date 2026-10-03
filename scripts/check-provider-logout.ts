import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assertSafeRuntimeRole,
  createDatabase,
  providerLogoutHealth,
} from '@kinto/database';
import { readAuthConfig } from '../apps/api/src/auth/config';
import { checkLogoutHealth } from '../apps/api/src/auth/logout-health';

// Operations-only command. No listener, API route or customer-facing metrics.
async function main() {
  let db: ReturnType<typeof createDatabase> | undefined;
  try {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = readAuthConfig(process.env);
    if (!config || config.logoutMode !== 'durable') {
      console.log(
        JSON.stringify({
          status: 'unavailable',
          alerts: ['logout_durable_mode_required'],
          backlog: null,
        }),
      );
      return 1;
    }
    const settings = z
      .object({
        url: z.url(),
        age: z.coerce.number().int().positive().max(86400).default(300),
        idle: z.coerce.number().int().positive().max(86400).default(30),
      })
      .parse({
        url: process.env.DATABASE_URL,
        age: process.env.AUTH_LOGOUT_MAX_PENDING_SECONDS,
        idle: process.env.AUTH_LOGOUT_MAX_IDLE_SECONDS,
      });
    const namespace = createHash('sha256')
      .update(`${config.issuer}|${config.clientId}|${config.origin}`)
      .digest('hex');
    db = createDatabase(settings.url);
    const database = db;
    const report = await checkLogoutHealth(
      async () => {
        await assertSafeRuntimeRole(database);
        return providerLogoutHealth(database, namespace);
      },
      settings.age,
      settings.idle,
    );
    console.log(JSON.stringify(report));
    return report.status === 'ready' ? 0 : 1;
  } catch {
    console.log(
      JSON.stringify({
        status: 'unavailable',
        alerts: ['logout_monitor_configuration_invalid'],
        backlog: null,
      }),
    );
    return 1;
  } finally {
    // A timed-out database connection must not hang the scheduler indefinitely.
    if (db)
      await Promise.race([
        db.$disconnect().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1000).unref()),
      ]);
  }
}
void main().then((code) => process.exit(code));
