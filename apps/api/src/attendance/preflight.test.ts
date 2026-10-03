import { expect, it } from 'vitest';
import {
  prepareAttendanceBatch,
  type AttendanceConnectorScope,
} from './preflight';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: AttendanceConnectorScope = {
  tenantId: uuid(1),
  connectorId: uuid(2),
  deviceId: uuid(3),
  status: 'active',
  adapterVersion: 'synthetic-1',
  sourceIdentity: { kind: 'vendor_event_id', resetEpoch: uuid(4) },
};
const event = (n = 5) => ({
  connectorEventId: uuid(n),
  sourceUserId: '00007',
  sourceLocalTimestamp: '2026-10-04T09:00:00',
  sourceEventId: '0001',
});
const batch = (events: unknown[] = [event()]) => ({
  batchId: uuid(6),
  schemaVersion: 1,
  deviceId: scope.deviceId,
  adapterVersion: scope.adapterVersion,
  events,
});
const candidate = (input = batch(), context = scope) => {
  const entry = prepareAttendanceBatch(input, context).entries[0];
  if (entry.state !== 'candidate') throw new Error('Expected candidate');
  return entry;
};

it('preserves source values and deterministic retry identities without mutating input', () => {
  const input = batch();
  const before = JSON.stringify(input);
  const first = candidate(input);
  expect(candidate(input)).toEqual(first);
  expect(JSON.stringify(input)).toBe(before);
  expect(first.event).toEqual(event());
  expect(first.requiresSourceIdentityReview).toBe(false);
  expect(first.transportKey).toMatch(/^[a-f0-9]{64}$/);
  expect(first.sourceKey).toMatch(/^[a-f0-9]{64}$/);
  const replaced = candidate(batch([event(7)]), {
    ...scope,
    connectorId: uuid(8),
    adapterVersion: scope.adapterVersion,
  });
  expect(replaced.sourceKey).toBe(first.sourceKey);
  expect(replaced.contentHash).toBe(first.contentHash);
  expect(replaced.transportKey).not.toBe(first.transportKey);
  for (const context of [
    { ...scope, tenantId: uuid(9) },
    { ...scope, deviceId: uuid(9) },
    {
      ...scope,
      sourceIdentity: { kind: 'vendor_event_id' as const, resetEpoch: uuid(9) },
    },
  ]) {
    expect(
      candidate({ ...input, deviceId: context.deviceId }, context).sourceKey,
    ).not.toBe(first.sourceKey);
  }
});

it('never trusts unverified source IDs or collapses legitimate identical-time punches', () => {
  const context: AttendanceConnectorScope = {
    ...scope,
    sourceIdentity: { kind: 'unverified' },
  };
  const withoutId: Partial<ReturnType<typeof event>> = event();
  delete withoutId.sourceEventId;
  const entries = prepareAttendanceBatch(
    batch([withoutId, { ...event(7), direction: 'out', workCode: 'W1' }]),
    context,
  ).entries;
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.state).toBe('candidate');
    if (entry.state === 'candidate') {
      expect(entry.sourceKey).toBeNull();
      expect(entry.requiresSourceIdentityReview).toBe(true);
    }
  }
  const proven = prepareAttendanceBatch(
    batch([event(), { ...event(7), sourceEventId: '0002' }]),
    scope,
  ).entries;
  expect(proven.every((entry) => entry.state === 'candidate')).toBe(true);
  expect(proven[0]).not.toEqual(proven[1]);
});

it('rejects malformed rows separately without returning sensitive raw values', () => {
  const withoutId: Partial<ReturnType<typeof event>> = event(8);
  delete withoutId.sourceEventId;
  const result = prepareAttendanceBatch(
    batch([
      event(),
      { ...event(7), fingerprint: 'SECRET_TEMPLATE' },
      null,
      withoutId,
    ]),
    scope,
  );
  expect(result.entries.map((entry) => entry.state)).toEqual([
    'candidate',
    'rejected_unstored',
    'rejected_unstored',
    'rejected_unstored',
  ]);
  expect(result.entries[1]).toEqual({
    index: 1,
    state: 'rejected_unstored',
    connectorEventId: uuid(7),
    code: 'invalid_event',
  });
  expect(result.entries[2]).toEqual({
    index: 2,
    state: 'rejected_unstored',
    code: 'invalid_event',
  });
  expect(result.entries[3]).toMatchObject({ code: 'source_identity_missing' });
  expect(JSON.stringify(result)).not.toContain('SECRET_TEMPLATE');
});

it('rejects every duplicated transport ID including IDs on malformed rows', () => {
  const entries = prepareAttendanceBatch(
    batch([
      event(),
      { ...event(), photo: 'secret' },
      { ...event(7), sourceEventId: '2' },
    ]),
    scope,
  ).entries;
  expect(
    entries
      .slice(0, 2)
      .map((entry) => entry.state === 'rejected_unstored' && entry.code),
  ).toEqual(['duplicate_transport_id', 'duplicate_transport_id']);
  expect(entries[2].state).toBe('candidate');
});

it('rejects all contradictory source identities independently of row order', () => {
  const a = event();
  const b = { ...event(7), direction: 'out' };
  for (const rows of [
    [a, b],
    [b, a],
  ]) {
    const entries = prepareAttendanceBatch(batch(rows), scope).entries;
    expect(
      entries.every(
        (entry) =>
          entry.state === 'rejected_unstored' &&
          entry.code === 'source_identity_conflict',
      ),
    ).toBe(true);
  }
  // Identical source rows remain candidates; only a future transactional store may acknowledge duplicates.
  expect(
    prepareAttendanceBatch(batch([a, event(7)]), scope).entries.every(
      (entry) => entry.state === 'candidate',
    ),
  ).toBe(true);
});

it('fails closed for invalid scope, envelope, device and adapter with static errors', () => {
  expect(() =>
    prepareAttendanceBatch(batch(), {
      ...scope,
      status: 'revoked',
    } as unknown as AttendanceConnectorScope),
  ).toThrow('CONNECTOR_SCOPE_UNAVAILABLE');
  for (const change of [
    { tenantId: uuid(9) },
    { connectorId: uuid(9) },
    { timezone: 'Asia/Karachi' },
    { schemaVersion: 2 },
    { events: [] },
    { events: Array(501).fill(event()) },
  ])
    expect(() =>
      prepareAttendanceBatch({ ...batch(), ...change }, scope),
    ).toThrow('INVALID_BATCH');
  expect(() =>
    prepareAttendanceBatch({ ...batch(), deviceId: uuid(9) }, scope),
  ).toThrow('DEVICE_NOT_ALLOWED');
  expect(() =>
    prepareAttendanceBatch({ ...batch(), adapterVersion: 'other' }, scope),
  ).toThrow('ADAPTER_NOT_ALLOWED');
  expect(() =>
    prepareAttendanceBatch(
      batch(
        Array.from({ length: 500 }, (_, n) => ({
          ...event(n + 20),
          sourceEventId: String(n),
        })),
      ),
      scope,
    ),
  ).not.toThrow();
});

it('bounds serialized UTF8 bytes and rejects unserializable input without leaking content', () => {
  expect(() =>
    prepareAttendanceBatch(batch([{ secret: '界'.repeat(340_000) }]), scope),
  ).toThrow('INVALID_BATCH');
  expect(
    prepareAttendanceBatch(batch([{ secret: 'a'.repeat(900_000) }]), scope)
      .entries[0].state,
  ).toBe('rejected_unstored');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const row of [circular, { value: 1n }])
    expect(() => prepareAttendanceBatch(batch([row]), scope)).toThrow(
      'INVALID_BATCH',
    );
});

it('canonicalizes UUID case before scope comparisons and retry keys', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rows = [
    { ...event(), connectorEventId: id },
    { ...event(7), connectorEventId: id.toUpperCase() },
  ];
  expect(
    prepareAttendanceBatch(batch(rows), scope).entries.every(
      (entry) =>
        entry.state === 'rejected_unstored' &&
        entry.code === 'duplicate_transport_id',
    ),
  ).toBe(true);
  const context = { ...scope, tenantId: id, deviceId: id };
  const input = { ...batch(), deviceId: id };
  expect(
    candidate(
      { ...input, deviceId: id.toUpperCase() },
      { ...context, tenantId: id.toUpperCase(), deviceId: id.toUpperCase() },
    ),
  ).toEqual(candidate(input, context));
});
