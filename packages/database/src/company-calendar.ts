import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  companyCalendarPolicyDraftSchema,
  companyCalendarPublishSchema,
  companyCalendarQuerySchema,
  companyCalendarPolicySchema,
  companyCalendarListSchema,
  companyCalendarMutationSchema,
  companyCalendarDaysQuerySchema,
  companyCalendarDaysSchema,
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
export async function listCompanyCalendarPolicies(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  query: unknown = {},
) {
  scope(actor, tenant);
  const input = companyCalendarQuerySchema.parse(query);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.read_company_calendar_policies(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${input.limit}::integer,${input.afterId ?? null}::uuid,${input.asOf ?? null}::date)`;
  const raw = z
    .strictObject({
      tenantId: z.uuid().toLowerCase(),
      asOf: z.iso.date(),
      latestPublishedVersion: z.number().int().nonnegative(),
      currentPolicy: companyCalendarPolicySchema.nullable(),
      items: companyCalendarPolicySchema.array().max(51),
    })
    .parse(result(row));
  if (
    raw.tenantId !== tenant.toLowerCase() ||
    (input.asOf && raw.asOf !== input.asOf) ||
    raw.items.some(
      (v, i) =>
        (input.afterId && v.id <= input.afterId) ||
        (i > 0 && v.id <= raw.items[i - 1].id),
    ) ||
    (raw.currentPolicy &&
      (raw.currentPolicy.status !== 'published' ||
        raw.currentPolicy.effectiveFrom > raw.asOf ||
        raw.currentPolicy.version > raw.latestPublishedVersion ||
        raw.currentPolicy.effectiveUntil === null ||
        raw.currentPolicy.effectiveUntil <= raw.asOf))
  )
    throw new DomainError('INVALID_STATE');
  const items = raw.items.slice(0, input.limit);
  return companyCalendarListSchema.parse({
    ...raw,
    items,
    nextCursor: raw.items.length > input.limit ? items.at(-1)!.id : null,
    leaveReservationAvailable: false,
    attendanceProcessingAvailable: false,
    payrollEffectsAvailable: false,
  });
}
export async function createCompanyCalendarPolicyDraft(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  key: string,
  input: unknown,
) {
  scope(actor, tenant);
  z.uuid().parse(key);
  const value = companyCalendarPolicyDraftSchema.parse(input);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.mutate_company_calendar_policy(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${key}::uuid,'create'::varchar,NULL::uuid,${value.expectedCurrentVersion}::integer,${value.effectiveFrom}::date,${JSON.stringify(value.settings)}::jsonb,${value.reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
  const receipt = companyCalendarMutationSchema.parse(result(row));
  if (receipt.version <= value.expectedCurrentVersion)
    throw new DomainError('INVALID_STATE');
  return receipt;
}
export async function publishCompanyCalendarPolicy(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  id: string,
  key: string,
  input: unknown,
) {
  scope(actor, tenant);
  z.uuid().parse(key);
  z.uuid().parse(id);
  const value = companyCalendarPublishSchema.parse(input);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.mutate_company_calendar_policy(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${key}::uuid,'publish'::varchar,${id}::uuid,${value.expectedVersion}::integer,NULL::date,NULL::jsonb,${value.reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
  const receipt = companyCalendarMutationSchema.parse(result(row));
  if (
    receipt.id !== id.toLowerCase() ||
    receipt.version !== value.expectedVersion
  )
    throw new DomainError('INVALID_STATE');
  return receipt;
}

export async function resolveCompanyCalendarDays(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  query: unknown,
) {
  scope(actor, tenant);
  const input = companyCalendarDaysQuerySchema.parse(query);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.resolve_company_calendar_days(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${input.from}::date,${input.until}::date)`;
  const state = companyCalendarDaysSchema.parse({
    ...(result(row) as object),
    leaveReservationAvailable: false,
    attendanceProcessingAvailable: false,
    payrollEffectsAvailable: false,
  });
  const length =
    (Date.parse(input.until + 'T00:00:00Z') -
      Date.parse(input.from + 'T00:00:00Z')) /
      86400000 +
    1;
  if (
    state.tenantId !== tenant.toLowerCase() ||
    state.from !== input.from ||
    state.until !== input.until ||
    state.days.length !== length ||
    state.days.some(
      (d, i) =>
        d.date !==
        new Date(Date.parse(input.from + 'T00:00:00Z') + i * 86400000)
          .toISOString()
          .slice(0, 10),
    )
  )
    throw new DomainError('INVALID_STATE');
  return state;
}
