import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  attendanceTimingPolicyDraftSchema,
  attendanceTimingPublishSchema,
  attendanceTimingQuerySchema,
  attendanceTimingPolicySchema,
  attendanceTimingListSchema,
  attendanceTimingMutationSchema,
  attendanceTimingPreviewSchema,
} from '@kinto/contracts';
import { DomainError, previewAttendanceTiming } from '@kinto/domain';
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
export async function listAttendanceTimingPolicies(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  query: unknown = {},
) {
  scope(actor, tenant);
  const input = attendanceTimingQuerySchema.parse(query);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.read_attendance_timing_policies(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${input.limit}::integer,${input.afterId ?? null}::uuid,${input.asOf ?? null}::date)`;
  const raw = z
    .strictObject({
      tenantId: z.uuid().toLowerCase(),
      asOf: z.iso.date(),
      latestPublishedVersion: z.number().int().nonnegative(),
      currentPolicy: attendanceTimingPolicySchema.nullable(),
      items: attendanceTimingPolicySchema.array().max(51),
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
        raw.currentPolicy.version > raw.latestPublishedVersion))
  )
    throw new DomainError('INVALID_STATE');
  const items = raw.items.slice(0, input.limit);
  return attendanceTimingListSchema.parse({
    ...raw,
    items,
    nextCursor: raw.items.length > input.limit ? items.at(-1)!.id : null,
    attendanceProcessingAvailable: false,
    payrollEffectsAvailable: false,
  });
}
export async function previewAttendanceTimingPolicy(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  id: string,
) {
  scope(actor, tenant);
  z.uuid().parse(id);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.read_attendance_timing_policy(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${id}::uuid)`;
  const policy = attendanceTimingPolicySchema.parse(result(row));
  if (policy.id !== id.toLowerCase()) throw new DomainError('INVALID_STATE');
  const schedule = previewAttendanceTiming(policy.settings);
  return attendanceTimingPreviewSchema.parse({
    tenantId: tenant,
    policy,
    dayAnchor: schedule.dayAnchor,
    scheduledMinutes: schedule.scheduledMinutes,
    netScheduledMinutes: schedule.netScheduledMinutes,
    associationWindow: schedule.associationWindow,
    attendanceProcessingAvailable: false,
    payrollEffectsAvailable: false,
  });
}
export async function createAttendanceTimingPolicyDraft(
  db: PrismaClient,
  actor: OrganizationActor,
  tenant: string,
  key: string,
  input: unknown,
) {
  scope(actor, tenant);
  z.uuid().parse(key);
  const value = attendanceTimingPolicyDraftSchema.parse(input);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.mutate_attendance_timing_policy(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${key}::uuid,'create'::varchar,NULL::uuid,${value.expectedCurrentVersion}::integer,${value.effectiveFrom}::date,${JSON.stringify(value.settings)}::jsonb,${value.reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
  return attendanceTimingMutationSchema.parse(result(row));
}
export async function publishAttendanceTimingPolicy(
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
  const value = attendanceTimingPublishSchema.parse(input);
  const [row] = await db.$queryRaw<
    { outcome: string; snapshot: unknown }[]
  >`SELECT * FROM public.mutate_attendance_timing_policy(${actor.identityId}::uuid,${actor.mfaVerified},${tenant}::uuid,${key}::uuid,'publish'::varchar,${id}::uuid,${value.expectedVersion}::integer,NULL::date,NULL::jsonb,${value.reason}::varchar,${randomUUID()}::uuid,${randomUUID()}::uuid)`;
  const receipt = attendanceTimingMutationSchema.parse(result(row));
  if (
    receipt.id !== id.toLowerCase() ||
    receipt.version !== value.expectedVersion
  )
    throw new DomainError('INVALID_STATE');
  return receipt;
}
