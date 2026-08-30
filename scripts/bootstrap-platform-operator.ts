import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createDatabase } from '@kinto/database';

if (existsSync('.env')) process.loadEnvFile('.env');

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
const issuer = process.env.PLATFORM_BOOTSTRAP_ISSUER?.trim();
const subject = process.env.PLATFORM_BOOTSTRAP_SUBJECT?.trim();
const confirmation = process.env.PLATFORM_BOOTSTRAP_CONFIRM;
if (!databaseUrl || !issuer || !subject)
  throw new Error('Protected operator bootstrap inputs are required');
if (confirmation !== 'bootstrap-first-platform-operator')
  throw new Error('Explicit operator bootstrap confirmation is required');
if (subject.length > 255) throw new Error('Invalid operator subject');
const issuerUrl = new URL(issuer);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname);
if (
  issuer.length > 512 ||
  issuerUrl.username ||
  issuerUrl.password ||
  issuerUrl.search ||
  issuerUrl.hash ||
  (issuerUrl.protocol !== 'https:' &&
    !(local && issuerUrl.protocol === 'http:'))
)
  throw new Error('Invalid operator issuer');

const database = createDatabase(databaseUrl);
try {
  const result = await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('kinto:first-platform-operator', 0))::text`;
    const existing = await tx.platformOperator.findMany({
      include: { identity: true },
    });
    if (existing.length) {
      if (
        existing.length === 1 &&
        existing[0].status === 'active' &&
        existing[0].identity.status === 'active' &&
        existing[0].identity.issuer === issuer &&
        existing[0].identity.subject === subject
      )
        return 'already-present' as const;
      throw new Error('A platform operator already exists');
    }
    const identity = await tx.identity.upsert({
      where: { issuer_subject: { issuer, subject } },
      create: { issuer, subject },
      update: {},
    });
    if (identity.status !== 'active')
      throw new Error('The bootstrap identity is disabled');
    await tx.platformOperator.create({ data: { identityId: identity.id } });
    await tx.platformAuditEvent.create({
      data: {
        id: randomUUID(),
        actorId: identity.id,
        action: 'platform_operator.bootstrapped',
        resourceId: identity.id,
      },
    });
    return 'created' as const;
  });
  console.log(
    result === 'created'
      ? 'First platform operator created and audited.'
      : 'The requested first platform operator is already active.',
  );
} finally {
  await database.$disconnect();
}
