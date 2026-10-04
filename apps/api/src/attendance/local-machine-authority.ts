import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  listConnectorEnrollments,
  listConnectorCredentials,
  createDatabase,
  issueBoundConnectorEnrollment,
  redeemConnectorEnrollment,
  readConnectorCredentialCandidate,
  readConnectorSecurityRecord,
  revokeBoundConnectorEnrollment,
  revokeConnectorCredential,
  type OrganizationActor,
} from '@kinto/database';
import {
  connectorCredentialSchema,
  type EnrollmentIssue,
  type EnrollmentListQuery,
} from '@kinto/contracts';
import { DomainError } from '@kinto/domain';
import { AuthStore } from '../auth/store';
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// Synthetic authority only; the optional HTTP wrapper rejects production configuration.
// Independent security state: never evict individual seals or restore it with SQL backups.
export class LocalMachineAuthority {
  private readonly db;
  private readonly store: AuthStore;
  readonly prefix: string;
  constructor(databaseUrl: string, redisUrl: string, namespace: string) {
    const dbUrl = new URL(databaseUrl),
      redis = new URL(redisUrl);
    if (
      !['postgres:', 'postgresql:'].includes(dbUrl.protocol) ||
      !dbUrl.pathname.startsWith('/kinto_test') ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) ||
      redis.protocol !== 'redis:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname) ||
      !/^\/(?:[2-9]|1[0-5])$/.test(redis.pathname)
    )
      throw new Error(
        'Local machine authority requires synthetic loopback databases and separate Redis DB 2–15',
      );
    this.prefix = `kinto:machine:local:v1:${z.uuid().parse(namespace)}:`;
    this.db = createDatabase(databaseUrl);
    this.store = new AuthStore(redisUrl, this.prefix);
  }
  async connect() {
    await this.store.connect();
    await this.db.$queryRaw`SELECT 1`;
  }
  async close() {
    this.store.close();
    await this.db.$disconnect();
  }
  async ready() {
    await this.store.ready();
    await this.db.$queryRaw`SELECT 1`;
  }
  allow(ip: string) {
    return this.store.allow(ip);
  }
  enrollments(
    actor: OrganizationActor,
    tenant: string,
    input: EnrollmentListQuery,
  ) {
    return listConnectorEnrollments(this.db, actor, tenant, input);
  }
  credentials(
    actor: OrganizationActor,
    tenant: string,
    input: EnrollmentListQuery,
  ) {
    return listConnectorCredentials(this.db, actor, tenant, input);
  }
  private async generation() {
    await this.store.redis.set(
      this.prefix + 'generation',
      randomBytes(32).toString('base64url'),
      'NX',
    );
    const value = await this.store.redis.get(this.prefix + 'generation');
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new Error('Machine admission unavailable');
    return digest(value);
  }
  private used(generation: string, tokenDigest: string) {
    return this.prefix + 'used:' + generation + ':' + tokenDigest;
  }
  private permit(id: string) {
    return this.prefix + 'permit:' + id;
  }
  async issue(
    actor: OrganizationActor,
    tenantId: string,
    requestId: string,
    input: EnrollmentIssue,
  ) {
    return issueBoundConnectorEnrollment(
      this.db,
      actor,
      tenantId,
      requestId,
      input,
      await this.generation(),
    );
  }
  async redeem(token: string) {
    z.string()
      .regex(/^ke1_[A-Za-z0-9_-]{43}$/)
      .parse(token);
    const generation = await this.generation();
    // Burn BEFORE SQL: even SQL failure/response loss cannot make an old backup reusable.
    const sealed = await this.store.redis.set(
      this.used(generation, digest(token)),
      'consumed',
      'EX',
      900,
      'NX',
    );
    if (sealed !== 'OK') throw new DomainError('FORBIDDEN');
    const result = await redeemConnectorEnrollment(this.db, token, generation);
    if ((await this.generation()) !== generation)
      throw new DomainError('FORBIDDEN');
    const ttl = Math.floor(
      (Date.parse(result.connector.expiresAt) - Date.now()) / 1000,
    );
    if (ttl <= 0) throw new DomainError('FORBIDDEN');
    // Admission is positively granted only AFTER commit, never reconstructed from restored rows.
    const granted = await this.store.redis.set(
      this.permit(result.connector.id),
      generation + ':' + digest(result.credential),
      'EX',
      ttl,
      'NX',
    );
    if (granted !== 'OK') throw new DomainError('FORBIDDEN');
    return result;
  }
  async authorize(credential: string) {
    connectorCredentialSchema.parse(credential);
    const generation = await this.generation();
    const candidate = await readConnectorCredentialCandidate(
      this.db,
      credential,
      generation,
    );
    if (
      (await this.store.redis.get(this.permit(candidate.id))) !==
        generation + ':' + digest(credential) ||
      (await this.generation()) !== generation
    )
      throw new DomainError('FORBIDDEN');
    return candidate;
  }
  async revokeEnrollment(
    actor: OrganizationActor,
    tenantId: string,
    id: string,
  ) {
    const record = await readConnectorSecurityRecord(
      this.db,
      actor,
      tenantId,
      id,
      'enrollment',
    );
    if (record.generation)
      await this.store.redis.set(
        this.used(record.generation, record.digest),
        'revoked',
        'EX',
        900,
      );
    return revokeBoundConnectorEnrollment(this.db, actor, tenantId, id);
  }
  async revokeCredential(
    actor: OrganizationActor,
    tenantId: string,
    id: string,
  ) {
    await readConnectorSecurityRecord(
      this.db,
      actor,
      tenantId,
      id,
      'credential',
    );
    // A tombstone BEFORE SQL also prevents a late redemption from granting admission.
    await this.store.redis.set(this.permit(id), 'revoked', 'EX', 2592000);
    return revokeConnectorCredential(this.db, actor, tenantId, id);
  }
}
