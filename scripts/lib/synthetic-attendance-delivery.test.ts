import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AttendanceQueueError,
  SyntheticAttendanceQueue,
} from './synthetic-attendance-queue';
import {
  SyntheticAttendanceDelivery,
  SyntheticTransportFailure,
  type SyntheticAttendanceTransport,
} from './synthetic-attendance-delivery';
let directory: string;
let queue: SyntheticAttendanceQueue;
const binding = {
  tenantId: randomUUID(),
  connectorId: randomUUID(),
  deviceId: randomUUID(),
  adapterVersion: 'synthetic-1',
};
type Batch = NonNullable<ReturnType<SyntheticAttendanceQueue['nextBatch']>>;
const event = () => ({
  connectorEventId: randomUUID(),
  sourceUserId: '0007',
  sourceLocalTimestamp: '2026-10-09T09:00:00',
});
const reply = (batch: Batch) => ({
  receiptId: randomUUID(),
  batchId: batch.batchId,
  deviceId: batch.deviceId,
  schemaVersion: 1,
  events: batch.events.map((event, index) => ({
    index,
    connectorEventId: event.connectorEventId,
    disposition: 'quarantined',
    code: 'source_identity_unverified',
  })),
});
const runner = (
  transport: SyntheticAttendanceTransport,
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: number;
  } = {},
) =>
  new SyntheticAttendanceDelivery(queue, transport, {
    mode: 'local_test',
    ...options,
  });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kinto-delivery-'));
  queue = new SyntheticAttendanceQueue({
    mode: 'local_test',
    directory,
    binding,
  });
});
afterEach(() => {
  queue.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
it('does not invoke transport for an empty or held-only queue', async () => {
  const transport = vi.fn(async (batch: Batch) => reply(batch));
  const r = runner(transport);
  expect(await r.deliver()).toEqual({ outcome: 'idle', attempts: 0 });
  queue.capture([event()]);
  const batch = queue.nextBatch()!;
  const receipt = reply(batch);
  queue.acknowledge({
    ...receipt,
    events: [
      {
        index: 0,
        connectorEventId: batch.events[0].connectorEventId,
        disposition: 'rejected_unstored',
        code: 'invalid_event',
      },
    ],
  });
  expect(await r.deliver()).toEqual({ outcome: 'idle', attempts: 0 });
  expect(transport).not.toHaveBeenCalled();
});
it('reconciles one batch and leaves later captures for the next explicit delivery', async () => {
  queue.capture([event()]);
  const r = runner(async (batch) => {
    queue.capture([event()]);
    return reply(batch);
  });
  expect(await r.deliver()).toEqual({ outcome: 'delivered', attempts: 1 });
  expect(queue.summary()).toMatchObject({ pending: 1, acknowledged: 1 });
});
it('retries only classified transient failures with bounded exponential waits and identical input', async () => {
  vi.useFakeTimers();
  queue.capture([event()]);
  const calls: Batch[] = [];
  const r = runner(
    async (batch) => {
      calls.push(batch);
      if (calls.length < 3) throw new SyntheticTransportFailure('transient');
      return reply(batch);
    },
    { backoffMs: 10, maxAttempts: 3 },
  );
  const pending = r.deliver();
  await vi.advanceTimersByTimeAsync(9);
  expect(calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(20);
  expect(await pending).toEqual({ outcome: 'delivered', attempts: 3 });
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
});
it('exhausts bounded attempts without acknowledging and permits explicit retry', async () => {
  vi.useFakeTimers();
  queue.capture([event()]);
  const transport = vi.fn(async () => {
    throw new SyntheticTransportFailure('transient');
  });
  const r = runner(transport, { maxAttempts: 2, backoffMs: 10 });
  const first = r.deliver();
  await vi.advanceTimersByTimeAsync(10);
  expect(await first).toEqual({
    outcome: 'paused',
    attempts: 2,
    reason: 'retry_exhausted',
  });
  const batch = queue.nextBatch();
  const second = r.deliver();
  await vi.advanceTimersByTimeAsync(10);
  await second;
  expect(queue.nextBatch()).toEqual(batch);
  expect(queue.summary().pending).toBe(1);
});
it('redacts unknown diagnostics and does not automatically retry uncertain commits', async () => {
  queue.capture([event()]);
  const transport = vi.fn(async () => {
    throw new Error('SECRET-SERVER-DIAGNOSTIC');
  });
  expect(await runner(transport).deliver()).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'unconfirmed',
  });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(queue.summary().pending).toBe(1);
});
it('makes classified denial terminal for this coordinator without removing punches', async () => {
  queue.capture([event()]);
  const transport = vi.fn(async () => {
    throw new SyntheticTransportFailure('denied');
  });
  const r = runner(transport);
  expect(await r.deliver()).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'denied',
  });
  await expect(r.deliver()).rejects.toThrow('DENIED');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(queue.summary().pending).toBe(1);
});
it('times out an uncooperative callback without overlapping attempts or accepting late ACKs', async () => {
  vi.useFakeTimers();
  queue.capture([event()]);
  let resolve!: (reply: unknown) => void;
  let sent!: Batch;
  let signal!: AbortSignal;
  const r = runner(
    (batch, s) => {
      sent = batch;
      signal = s;
      return new Promise((r) => {
        resolve = r;
      });
    },
    { timeoutMs: 10 },
  );
  const pending = r.deliver();
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'timeout',
  });
  expect(signal.aborted).toBe(true);
  await expect(r.deliver()).rejects.toThrow('BUSY');
  resolve(reply(sent));
  await vi.advanceTimersByTimeAsync(0);
  expect(queue.summary().pending).toBe(1);
  expect(queue.nextBatch()).toEqual(sent);
});
it('allows explicit retry only after timed-out transport has settled', async () => {
  vi.useFakeTimers();
  queue.capture([event()]);
  let calls = 0;
  const r = runner(
    (batch, signal) => {
      calls++;
      if (calls === 2) return Promise.resolve(reply(batch));
      return new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new SyntheticTransportFailure('transient')),
          { once: true },
        ),
      );
    },
    { timeoutMs: 10 },
  );
  const pending = r.deliver();
  await vi.advanceTimersByTimeAsync(10);
  expect((await pending).outcome).toBe('paused');
  await vi.advanceTimersByTimeAsync(0);
  expect(await r.deliver()).toEqual({ outcome: 'delivered', attempts: 1 });
});
it('prevents concurrent calls and stop aborts promptly without late reconciliation', async () => {
  queue.capture([event()]);
  let resolve!: (reply: unknown) => void;
  let sent!: Batch;
  const r = runner((batch) => {
    sent = batch;
    return new Promise((r) => {
      resolve = r;
    });
  });
  const pending = r.deliver();
  await Promise.resolve();
  await expect(r.deliver()).rejects.toThrow('BUSY');
  r.stop();
  expect(await pending).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'stopped',
  });
  resolve(reply(sent));
  await Promise.resolve();
  expect(queue.summary().pending).toBe(1);
  await expect(r.deliver()).rejects.toThrow('STOPPED');
});
it('cancels backoff immediately and never invokes the next attempt', async () => {
  vi.useFakeTimers();
  queue.capture([event()]);
  const transport = vi.fn(async () => {
    throw new SyntheticTransportFailure('transient');
  });
  const r = runner(transport, { backoffMs: 10000 });
  const pending = r.deliver();
  await vi.advanceTimersByTimeAsync(0);
  r.stop();
  expect(await pending).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'stopped',
  });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('pauses on malformed or foreign receipts without modifying the frozen batch', async () => {
  queue.capture([event()]);
  const transport = vi.fn(async (batch) => ({
    ...reply(batch),
    deviceId: randomUUID(),
  }));
  expect(await runner(transport).deliver()).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'invalid_receipt',
  });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(queue.summary().pending).toBe(1);
});
it('reports local storage failure before sending and retains committed data', async () => {
  queue.capture([event()]);
  queue.close();
  const transport = vi.fn(async (batch) => reply(batch));
  expect(await runner(transport).deliver()).toEqual({
    outcome: 'paused',
    attempts: 0,
    reason: 'storage_unavailable',
  });
  expect(transport).not.toHaveBeenCalled();
});
it('preserves frozen input even if the transport mutates its argument', async () => {
  queue.capture([event()]);
  const frozen = queue.nextBatch();
  expect(
    (
      await runner(async (batch) => {
        batch.events[0].connectorEventId = randomUUID();
        return reply(batch);
      }).deliver()
    ).outcome,
  ).toBe('paused');
  expect(queue.nextBatch()).toEqual(frozen);
});
it('validates configuration and refuses production or non-synthetic mode', () => {
  const transport = async (batch: Batch) => reply(batch);
  for (const options of [
    { maxAttempts: 0 },
    { maxAttempts: 6 },
    { timeoutMs: 9 },
    { backoffMs: 0 },
  ])
    expect(() => runner(transport, options)).toThrow();
  expect(
    () =>
      new SyntheticAttendanceDelivery(queue, transport, {
        mode: 'live' as 'local_test',
      }),
  ).toThrow('UNAVAILABLE');
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => runner(transport)).toThrow('UNAVAILABLE');
});

it('pauses on local receipt commit failure and retries identical input only explicitly', async () => {
  queue.capture([event()]);
  const batches: Batch[] = [];
  const ack = vi.spyOn(queue, 'acknowledge').mockImplementationOnce(() => {
    throw new AttendanceQueueError('STORAGE_UNAVAILABLE');
  });
  const r = runner(async (batch) => {
    batches.push(batch);
    return reply(batch);
  });
  expect(await r.deliver()).toEqual({
    outcome: 'paused',
    attempts: 1,
    reason: 'storage_unavailable',
  });
  expect(queue.summary().pending).toBe(1);
  expect(batches).toHaveLength(1);
  expect(await r.deliver()).toEqual({ outcome: 'delivered', attempts: 1 });
  expect(batches[1]).toEqual(batches[0]);
  ack.mockRestore();
});
