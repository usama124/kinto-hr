import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  leaveTypeCreateSchema,
  leavePolicyDraftInputSchema,
  leavePolicyPublishSchema,
  leavePolicyQuerySchema,
  leaveTypeQuerySchema,
  leaveTypeListSchema,
  leavePolicyListSchema,
  leavePolicyMutationSchema,
  type LeavePolicyRecord,
} from '@kinto/contracts';
import { DomainError } from '@kinto/domain';
import type { PrismaClient, OrganizationActor } from './index';
function scope(actor: OrganizationActor, tenant: string) {
  z.uuid().parse(actor.identityId);
  z.boolean().parse(actor.mfaVerified);
  z.uuid().parse(tenant);
}
function result(row?: { outcome: string; snapshot: unknown }) {
  if (!row || row.outcome === 'forbidden') throw new DomainError('FORBIDDEN');
  if (row.outcome === 'not_found') throw new DomainError('NOT_FOUND');
  if (row.outcome === 'stale') throw new DomainError('STALE_VERSION');
  if (row.outcome === 'conflict') throw new DomainError('CONFLICT');
  if (row.outcome !== 'ok') throw new DomainError('INVALID_STATE');
  return row.snapshot;
}
const flags = {
  leaveReservationAvailable: false as const,
  payrollEffectsAvailable: false as const,
};
export async function listCompanyLeaveTypes(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  query: unknown = {},
) {
  scope(actor, tenant);
  const input = leaveTypeQuerySchema.parse(query);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.read_company_leave_policies(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,NULL::uuid,${input.limit}::integer,${input.afterId ?? null}::uuid,NULL::date)`;
  const raw = leaveTypeListSchema
    .omit({
      nextCursor: true,
      leaveReservationAvailable: true,
      payrollEffectsAvailable: true,
    })
    .extend({ items: leaveTypeListSchema.shape.items.element.array().max(51) })
    .parse(result(row));
  if (
    raw.tenantId !== tenant.toLowerCase() ||
    raw.items.some(
      (v, i) =>
        (input.afterId && v.id <= input.afterId) ||
        (i > 0 && v.id <= raw.items[i - 1].id),
    )
  )
    throw new DomainError('INVALID_STATE');
  const items = raw.items.slice(0, input.limit);
  return leaveTypeListSchema.parse({
    ...raw,
    items,
    nextCursor: raw.items.length > input.limit ? items.at(-1)!.id : null,
    ...flags,
  });
}
export async function listCompanyLeavePolicies(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  type: string,
  query: unknown = {},
) {
  scope(actor, tenant);
  z.uuid().parse(type);
  const input = leavePolicyQuerySchema.parse(query);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.read_company_leave_policies(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${type}::uuid,${input.limit}::integer,${input.afterId ?? null}::uuid,${input.asOf ?? null}::date)`;
  const raw = leavePolicyListSchema
    .omit({
      nextCursor: true,
      leaveReservationAvailable: true,
      payrollEffectsAvailable: true,
    })
    .extend({
      items: leavePolicyListSchema.shape.items.element.array().max(51),
    })
    .parse(result(row));
  const matches = (p: LeavePolicyRecord) =>
    p.tenantId === tenant.toLowerCase() &&
    p.leaveTypeId === type.toLowerCase() &&
    p.settings.code === raw.leaveType.code;
  if (
    raw.tenantId !== tenant.toLowerCase() ||
    raw.leaveType.id !== type.toLowerCase() ||
    (input.asOf && raw.asOf !== input.asOf) ||
    raw.items.some(
      (v, i) =>
        !matches(v) ||
        (input.afterId && v.id <= input.afterId) ||
        (i > 0 && v.id <= raw.items[i - 1].id),
    ) ||
    (raw.currentPolicy &&
      (!matches(raw.currentPolicy) ||
        raw.currentPolicy.status !== 'published' ||
        raw.currentPolicy.version > raw.latestPublishedVersion ||
        raw.currentPolicy.effectiveFrom > raw.asOf ||
        (raw.currentPolicy.effectiveUntil !== null &&
          raw.currentPolicy.effectiveUntil <= raw.asOf)))
  )
    throw new DomainError('INVALID_STATE');
  const items = raw.items.slice(0, input.limit);
  return leavePolicyListSchema.parse({
    ...raw,
    items,
    nextCursor: raw.items.length > input.limit ? items.at(-1)!.id : null,
    ...flags,
  });
}
async function mutate(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  key: string,
  kind: 'create_type' | 'draft' | 'publish',
  type: string | null,
  policy: string | null,
  input: unknown,
) {
  scope(actor, tenant);
  z.uuid().parse(key);
  if (type) z.uuid().parse(type);
  if (policy) z.uuid().parse(policy);
  const value =
    kind === 'publish'
      ? leavePolicyPublishSchema.parse(input)
      : kind === 'create_type'
        ? leaveTypeCreateSchema.parse(input)
        : leavePolicyDraftInputSchema.parse(input);
  const expected =
    'expectedVersion' in value
      ? value.expectedVersion
      : value.expectedCurrentVersion;
  const effective = 'effectiveFrom' in value ? value.effectiveFrom : null;
  const settings = 'settings' in value ? JSON.stringify(value.settings) : null;
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.mutate_company_leave_policy(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${key}::uuid,${kind}::varchar,${type}::uuid,${policy}::uuid,${expected}::integer,${effective}::date,${settings}::jsonb,${value.reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
  const receipt = leavePolicyMutationSchema.parse(result(row));
  if (
    (kind === 'create_type' && receipt.version !== 1) ||
    (kind === 'draft' && receipt.version <= expected) ||
    (type && receipt.leaveTypeId !== type.toLowerCase()) ||
    (policy &&
      (receipt.id !== policy.toLowerCase() || receipt.version !== expected))
  )
    throw new DomainError('INVALID_STATE');
  return receipt;
}
export function createCompanyLeaveType(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  key: string,
  input: unknown,
) {
  return mutate(db, actor, tenant, key, 'create_type', null, null, input);
}
export function createCompanyLeavePolicyDraft(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  type: string,
  key: string,
  input: unknown,
) {
  return mutate(db, actor, tenant, key, 'draft', type, null, input);
}
export function publishCompanyLeavePolicy(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  type: string,
  policy: string,
  key: string,
  input: unknown,
) {
  return mutate(db, actor, tenant, key, 'publish', type, policy, input);
}
