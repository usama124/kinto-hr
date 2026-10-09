import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyntheticAttendanceQueue } from './synthetic-attendance-queue';
import type { AttendanceBatchReceipt } from '@kinto/contracts';
let root: string;
const binding = {
  tenantId: randomUUID(),
  connectorId: randomUUID(),
  deviceId: randomUUID(),
  adapterVersion: 'synthetic-1',
};
const options = () => ({
  mode: 'local_test' as const,
  directory: join(root, 'queue'),
  binding,
});
const queues: SyntheticAttendanceQueue[] = [];
function open(
  extra: Partial<ReturnType<typeof options>> & {
    maxRecords?: number;
    maxPayloadBytes?: number;
  } = {},
) {
  const queue = new SyntheticAttendanceQueue({ ...options(), ...extra });
  queues.push(queue);
  return queue;
}
const event = (sourceEventId = '1') => ({
  connectorEventId: randomUUID(),
  sourceUserId: '0007',
  sourceLocalTimestamp: '2026-10-08T09:00:00',
  sourceEventId,
});
function receipt(
  queue: SyntheticAttendanceQueue,
  dispositions: (
    'stored' | 'duplicate' | 'quarantined' | 'rejected_unstored'
  )[] = ['quarantined'],
): AttendanceBatchReceipt {
  const batch = queue.nextBatch()!;
  return {
    receiptId: randomUUID(),
    batchId: batch.batchId,
    deviceId: batch.deviceId,
    schemaVersion: 1,
    events: batch.events.map((e, index) => {
      const disposition = dispositions[index];
      if (disposition === 'rejected_unstored')
        return {
          index,
          connectorEventId: e.connectorEventId,
          disposition,
          code: 'source_identity_conflict',
        };
      if (disposition === 'quarantined')
        return {
          index,
          connectorEventId: e.connectorEventId,
          disposition,
          code: 'source_identity_unverified',
        };
      return { index, connectorEventId: e.connectorEventId, disposition };
    }),
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinto-synthetic-queue-'));
});
afterEach(() => {
  for (const q of queues.splice(0)) q.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('commits capture before returning and retains exact transport and batch identity after restart', () => {
  const q = open();
  const e = event();
  expect(q.capture([e])).toEqual({ inserted: 1 });
  const batch = q.nextBatch();
  q.close();
  const restored = open();
  expect(restored.nextBatch()).toEqual(batch);
  expect(restored.capture([e])).toEqual({ inserted: 0 });
  expect(restored.summary()).toMatchObject({
    pending: 1,
    acknowledged: 0,
    held: 0,
  });
});
it('freezes a bounded batch while later captures wait for the next batch', () => {
  const q = open();
  const events = Array.from({ length: 500 }, (_, i) => event(String(i)));
  q.capture(events);
  const batch = q.nextBatch()!;
  q.capture([event('501')]);
  expect(q.nextBatch()).toEqual(batch);
  q.acknowledge(
    receipt(
      q,
      events.map(() => 'quarantined'),
    ),
  );
  expect(q.nextBatch()!.events).toHaveLength(1);
  expect(q.summary()).toMatchObject({ pending: 1, acknowledged: 500 });
});
it('deduplicates transport recapture but never distinct same-time source punches', () => {
  const q = open();
  const e = event();
  expect(q.capture([e, e, { ...e, connectorEventId: randomUUID() }])).toEqual({
    inserted: 2,
  });
  expect(q.nextBatch()!.events).toHaveLength(2);
});
it('rolls back an entire capture on reused transport content or full capacity', () => {
  const q = open({ maxRecords: 2 });
  const e = event();
  q.capture([e]);
  expect(() =>
    q.capture([event('2'), { ...e, sourceUserId: 'other' }]),
  ).toThrow('TRANSPORT_CONFLICT');
  expect(q.summary().pending).toBe(1);
  expect(() => q.capture([event('2'), event('3')])).toThrow('QUEUE_FULL');
  expect(q.summary().pending).toBe(1);
});
it('keeps acknowledged identity history and fails closed when the retained ledger fills', () => {
  const q = open({ maxRecords: 1 });
  const e = event();
  q.capture([e]);
  q.acknowledge(receipt(q));
  expect(q.capture([e])).toEqual({ inserted: 0 });
  expect(q.nextBatch()).toBeNull();
  expect(() => q.capture([event('2')])).toThrow('QUEUE_FULL');
  expect(q.summary().acknowledged).toBe(1);
});
it('rejects unsafe fields, malformed input and oversize capture cardinality before writing', () => {
  const q = open();
  for (const input of [
    [{ ...event(), fingerprint: 'SYNTHETIC-TEMPLATE' }],
    [{ ...event(), photo: 'SYNTHETIC-PHOTO' }],
    [null],
    [],
    Array.from({ length: 501 }, () => event()),
  ])
    expect(() => q.capture(input)).toThrow('INVALID_CAPTURE');
  expect(q.summary().pending).toBe(0);
  expect(
    readFileSync(
      join(options().directory, 'synthetic-attendance.sqlite'),
    ).includes(Buffer.from('SYNTHETIC-TEMPLATE')),
  ).toBe(false);
});
it('enforces retained sanitized payload bytes without discarding existing records', () => {
  const q = open({ maxPayloadBytes: 1024 });
  q.capture([event()]);
  expect(() => q.capture(Array.from({ length: 10 }, () => event()))).toThrow(
    'QUEUE_FULL',
  );
  expect(q.summary().pending).toBe(1);
});
it('atomically acknowledges positive dispositions and holds rejected records for explicit retry', () => {
  const q = open();
  const events = [event('1'), event('2'), event('3'), event('4')];
  q.capture(events);
  const r = receipt(q, [
    'stored',
    'duplicate',
    'quarantined',
    'rejected_unstored',
  ]);
  q.acknowledge(r);
  q.acknowledge(r);
  expect(q.summary()).toEqual({
    pending: 0,
    acknowledged: 3,
    held: 1,
    activeBatchId: null,
  });
  expect(q.nextBatch()).toBeNull();
  q.close();
  const reopened = open();
  expect(reopened.lastReceipt()).toEqual(r);
  reopened.acknowledge(r);
  reopened.retryHeld([events[3].connectorEventId]);
  expect(reopened.nextBatch()!.events).toEqual([events[3]]);
  expect(reopened.nextBatch()!.batchId).not.toBe(r.batchId);
});
it('rejects incomplete, reordered, foreign, unidentified or altered receipt entries without acknowledging anything', () => {
  const q = open();
  q.capture([event('1'), event('2')]);
  const r = receipt(q, ['quarantined', 'rejected_unstored']);
  const bad = [
    { ...r, batchId: randomUUID() },
    { ...r, deviceId: randomUUID() },
    { ...r, events: r.events.slice(0, 1) },
    { ...r, events: [r.events[1], r.events[0]] },
    {
      ...r,
      events: [{ ...r.events[0], connectorEventId: randomUUID() }, r.events[1]],
    },
    {
      ...r,
      events: [
        r.events[0],
        { index: 1, disposition: 'rejected_unstored', code: 'invalid_event' },
      ],
    },
    { ...r, credential: 'DO-NOT-PERSIST' },
  ];
  for (const input of bad)
    expect(() => q.acknowledge(input)).toThrow('INVALID_RECEIPT');
  expect(q.summary()).toMatchObject({
    pending: 2,
    acknowledged: 0,
    held: 0,
    activeBatchId: r.batchId,
  });
});
it('refuses stale receipts after a different batch has been frozen', () => {
  const q = open();
  q.capture([event()]);
  const r = receipt(q);
  q.acknowledge(r);
  q.capture([event('2')]);
  const next = q.nextBatch();
  expect(() => q.acknowledge(r)).toThrow('INVALID_RECEIPT');
  expect(q.nextBatch()).toEqual(next);
});
it('rolls back all held-record retries when one identity is not held', () => {
  const q = open();
  const e = event();
  q.capture([e]);
  q.acknowledge(receipt(q, ['rejected_unstored']));
  expect(() => q.retryHeld([e.connectorEventId, randomUUID()])).toThrow(
    'INVALID_STATE',
  );
  expect(q.summary().held).toBe(1);
  expect(() => q.retryHeld([e.connectorEventId, e.connectorEventId])).toThrow(
    'INVALID_STATE',
  );
});
it('binds stored queues to company, device, connector, adapter and immutable capacity settings', () => {
  const q = open();
  q.capture([event()]);
  q.close();
  for (const change of [
    { tenantId: randomUUID() },
    { deviceId: randomUUID() },
    { connectorId: randomUUID() },
    { adapterVersion: 'synthetic-2' },
  ])
    expect(() => open({ binding: { ...binding, ...change } })).toThrow(
      'BINDING_MISMATCH',
    );
  expect(() => open({ maxRecords: 10 })).toThrow('BINDING_MISMATCH');
  expect(open().summary().pending).toBe(1);
});
it('rejects production, non-local mode, relative directories and unsafe permissions', () => {
  expect(() => open({ directory: 'relative' })).toThrow('UNAVAILABLE');
  expect(
    () =>
      new SyntheticAttendanceQueue({
        ...options(),
        mode: 'live' as 'local_test',
      }),
  ).toThrow('UNAVAILABLE');
  mkdirSync(options().directory, { mode: 0o755 });
  expect(() => open()).toThrow('UNAVAILABLE');
  chmodSync(options().directory, 0o700);
  const q = open();
  q.close();
  chmodSync(join(options().directory, 'synthetic-attendance.sqlite'), 0o644);
  expect(() => open()).toThrow('UNAVAILABLE');
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => open()).toThrow('UNAVAILABLE');
});
it('refuses symlink ancestors, symlink database files and hard-linked databases', () => {
  const target = join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, options().directory);
  expect(() => open()).toThrow();
  rmSync(options().directory);
  mkdirSync(options().directory, { mode: 0o700 });
  const outside = join(root, 'outside');
  writeFileSync(outside, 'unchanged', { mode: 0o600 });
  const file = join(options().directory, 'synthetic-attendance.sqlite');
  symlinkSync(outside, file);
  expect(() => open()).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  rmSync(file);
  linkSync(outside, file);
  expect(() => open()).toThrow('UNAVAILABLE');
  expect(readFileSync(outside, 'utf8')).toBe('unchanged');
});
it('creates private POSIX files and returns isolated batches that cannot mutate persisted input', () => {
  const q = open();
  q.capture([event()]);
  const batch = q.nextBatch()!;
  batch.events[0].sourceUserId = 'mutated';
  expect(q.nextBatch()!.events[0].sourceUserId).toBe('0007');
  expect(statSync(options().directory).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(options().directory, 'synthetic-attendance.sqlite')).mode &
      0o777,
  ).toBe(0o600);
});
it('preserves pending state when receipt persistence fails and only acknowledges on committed retry', () => {
  const q = open();
  q.capture([event()]);
  const r = receipt(q);
  const db = new DatabaseSync(
    join(options().directory, 'synthetic-attendance.sqlite'),
  );
  db.exec(
    "CREATE TRIGGER fail_receipt BEFORE UPDATE OF last_receipt ON queue_state BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  expect(() => q.acknowledge(r)).toThrow('STORAGE_UNAVAILABLE');
  expect(q.summary()).toMatchObject({
    pending: 1,
    acknowledged: 0,
    activeBatchId: r.batchId,
  });
  db.exec('DROP TRIGGER fail_receipt');
  db.close();
  q.acknowledge(r);
  expect(q.summary().acknowledged).toBe(1);
});
it('retains committed state across abrupt child-process termination and permits another process to resume', () => {
  const module = resolve('scripts/lib/synthetic-attendance-queue.ts');
  const script = `import { SyntheticAttendanceQueue } from ${JSON.stringify(module)};
 const q=new SyntheticAttendanceQueue(${JSON.stringify(options())});q.capture([${JSON.stringify(event())}]);
 const batch=q.nextBatch();process.stdout.write(JSON.stringify(batch),()=>process.kill(process.pid,'SIGKILL'));`;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBe('SIGKILL');
  const batch = JSON.parse(result.stdout);
  const q = open();
  expect(q.nextBatch()).toEqual(batch);
  expect(q.summary().pending).toBe(1);
});
it('serializes separate handles and refuses corrupted frozen batches on reopen', () => {
  const a = open(),
    b = open();
  const e = event();
  a.capture([e]);
  expect(b.capture([e])).toEqual({ inserted: 0 });
  expect(a.nextBatch()).toEqual(b.nextBatch());
  a.close();
  b.close();
  const db = new DatabaseSync(
    join(options().directory, 'synthetic-attendance.sqlite'),
  );
  db.prepare('UPDATE queue_state SET active_batch=?').run(
    JSON.stringify({
      ...{
        batchId: randomUUID(),
        schemaVersion: 1,
        deviceId: randomUUID(),
        adapterVersion: binding.adapterVersion,
        events: [e],
      },
    }),
  );
  db.close();
  expect(() => open()).toThrow('CORRUPT');
});
it('fails closed after shutdown and when an existing database is unreadable', () => {
  const q = open();
  q.close();
  expect(() => q.capture([event()])).toThrow('UNAVAILABLE');
  expect(() => q.nextBatch()).toThrow('UNAVAILABLE');
  writeFileSync(
    join(options().directory, 'synthetic-attendance.sqlite'),
    'NOT-A-DATABASE',
    { mode: 0o600 },
  );
  expect(() => open()).toThrow('STORAGE_UNAVAILABLE');
});

it('recovers only committed records after a process dies in an open SQLite write transaction', () => {
  const q = open();
  const committed = event();
  q.capture([committed]);
  q.close();
  const uncommitted = event('2');
  const script = `import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync(${JSON.stringify(join(options().directory, 'synthetic-attendance.sqlite'))});
  db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
  db.prepare("INSERT INTO records(event_id,payload,status) VALUES(?,?,'pending')").run(${JSON.stringify(uncommitted.connectorEventId)},${JSON.stringify(JSON.stringify(uncommitted))});
  process.stdout.write('uncommitted',()=>process.kill(process.pid,'SIGKILL'));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBe('SIGKILL');
  expect(result.stdout).toBe('uncommitted');
  const restored = open();
  expect(restored.nextBatch()!.events).toEqual([committed]);
});
it('serializes concurrent processes capturing the same identity and freezing a batch', async () => {
  const q = open();
  q.close();
  const e = event();
  const module = resolve('scripts/lib/synthetic-attendance-queue.ts');
  const script = `import {SyntheticAttendanceQueue} from ${JSON.stringify(module)};
    const q=new SyntheticAttendanceQueue(${JSON.stringify(options())});q.capture([${JSON.stringify(e)}]);
    process.stdout.write(JSON.stringify(q.nextBatch()));q.close();`;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.stderr.resume();
      child.on('close', (code) =>
        code === 0
          ? resolve(output)
          : reject(new Error('Synthetic child failed')),
      );
    });
  const results = await Promise.all([run(), run()]);
  expect(JSON.parse(results[0])).toEqual(JSON.parse(results[1]));
  expect(open().summary().pending).toBe(1);
});

it('refuses unsafe SQLite sidecars without modifying their targets', () => {
  const q = open();
  q.close();
  const target = join(root, 'sidecar-target');
  writeFileSync(target, 'unchanged', { mode: 0o600 });
  const journal = join(
    options().directory,
    'synthetic-attendance.sqlite-journal',
  );
  symlinkSync(target, journal);
  expect(() => open()).toThrow('UNAVAILABLE');
  expect(readFileSync(target, 'utf8')).toBe('unchanged');
});
