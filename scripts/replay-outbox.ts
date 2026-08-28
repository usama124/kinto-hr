import { existsSync } from 'node:fs';
import { createDatabase } from '@kinto/database';
import { replayOutbox } from './lib/replay-outbox';

if (existsSync('.env')) process.loadEnvFile('.env');
async function main() {
  const value = process.env.MIGRATION_DATABASE_URL;
  if (!value) throw new Error('Local operator database required');
  const url = new URL(value);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.pathname.startsWith('/kinto_')
  )
    throw new Error('Replay CLI is restricted to local kinto_* databases');
  const [tenantId, eventId, actorId, reason, extra] = process.argv.slice(2);
  if (extra) throw new Error('Unexpected arguments');
  const db = createDatabase(value);
  try {
    await replayOutbox(db, { tenantId, eventId, actorId, reason });
    console.log(
      'Dead delivery reset with operator audit; dispatcher will retry it.',
    );
  } finally {
    await db.$disconnect();
  }
}
void main().catch(() => {
  console.error(
    'Replay refused/failed. Usage: pnpm worker:replay TENANT_UUID EVENT_UUID OPERATOR_UUID "reason (10–240 characters)"',
  );
  process.exitCode = 1;
});
