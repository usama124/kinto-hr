import { z } from 'zod';
import {
  AttendanceQueueError,
  SyntheticAttendanceQueue,
} from './synthetic-attendance-queue';

type Batch = NonNullable<ReturnType<SyntheticAttendanceQueue['nextBatch']>>;
export type SyntheticAttendanceTransport = (
  batch: Batch,
  signal: AbortSignal,
) => Promise<unknown>;
// Only explicitly classified fixture failures authorize automatic retry. Never
// infer retry eligibility or authorization from arbitrary server diagnostics.
export class SyntheticTransportFailure extends Error {
  constructor(readonly kind: 'transient' | 'denied') {
    super(kind);
  }
}
export class AttendanceDeliveryError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'BUSY' | 'STOPPED' | 'DENIED') {
    super(code);
  }
}
type Reason =
  | 'timeout'
  | 'unconfirmed'
  | 'retry_exhausted'
  | 'invalid_receipt'
  | 'storage_unavailable'
  | 'denied'
  | 'stopped';
export type DeliveryResult =
  | { outcome: 'idle'; attempts: 0 }
  | { outcome: 'delivered'; attempts: number }
  | { outcome: 'paused'; attempts: number; reason: Reason };

/** One bounded synthetic batch exercise. No HTTP, credentials, SDK or daemon. */
export class SyntheticAttendanceDelivery {
  #running = false;
  #unsettled = false;
  #stopped = false;
  #denied = false;
  #abort?: AbortController;
  #wake?: () => void;
  readonly #timeout: number;
  readonly #attempts: number;
  readonly #backoff: number;
  constructor(
    readonly queue: SyntheticAttendanceQueue,
    readonly transport: SyntheticAttendanceTransport,
    options: {
      mode: 'local_test';
      timeoutMs?: number;
      maxAttempts?: number;
      backoffMs?: number;
    },
  ) {
    if (options.mode !== 'local_test' || process.env.NODE_ENV === 'production')
      throw new AttendanceDeliveryError('UNAVAILABLE');
    this.#timeout = z
      .number()
      .int()
      .min(10)
      .max(30000)
      .parse(options.timeoutMs ?? 5000);
    this.#attempts = z
      .number()
      .int()
      .min(1)
      .max(5)
      .parse(options.maxAttempts ?? 3);
    this.#backoff = z
      .number()
      .int()
      .min(10)
      .max(10000)
      .parse(options.backoffMs ?? 250);
  }
  stop() {
    this.#stopped = true;
    this.#abort?.abort();
    this.#wake?.();
  }
  async deliver(): Promise<DeliveryResult> {
    if (this.#stopped) throw new AttendanceDeliveryError('STOPPED');
    if (this.#denied) throw new AttendanceDeliveryError('DENIED');
    if (this.#running || this.#unsettled)
      throw new AttendanceDeliveryError('BUSY');
    this.#running = true;
    let attempts = 0;
    try {
      const batch = this.queue.nextBatch();
      if (!batch) return { outcome: 'idle', attempts: 0 };
      while (attempts < this.#attempts) {
        attempts++;
        const controller = new AbortController();
        this.#abort = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let listener: (() => void) | undefined;
        this.#unsettled = true;
        // Resolve both success/failure so late completion cannot be an unhandled
        // rejection or acknowledge a batch after cancellation/timeout.
        const sent = Promise.resolve()
          .then(async () => {
            if (controller.signal.aborted) return { kind: 'aborted' as const };
            return this.transport(
              structuredClone(batch),
              controller.signal,
            ).then(
              (receipt) => ({ kind: 'reply' as const, receipt }),
              (error) => ({
                kind: 'failure' as const,
                error: error as unknown,
              }),
            );
          })
          .catch((error) => ({
            kind: 'failure' as const,
            error: error as unknown,
          }))
          .finally(() => {
            this.#unsettled = false;
          });
        const cancelled = new Promise<{ kind: 'aborted' }>((resolve) => {
          listener = () => resolve({ kind: 'aborted' });
          controller.signal.addEventListener('abort', listener, { once: true });
          timer = setTimeout(() => controller.abort(), this.#timeout);
        });
        let result: Awaited<typeof sent> | { kind: 'aborted' };
        try {
          result = await Promise.race([sent, cancelled]);
        } finally {
          clearTimeout(timer);
          if (listener)
            controller.signal.removeEventListener('abort', listener);
          this.#abort = undefined;
        }
        if (this.#stopped)
          return { outcome: 'paused', attempts, reason: 'stopped' };
        if (controller.signal.aborted || result.kind === 'aborted')
          return { outcome: 'paused', attempts, reason: 'timeout' };
        if (result.kind === 'reply') {
          this.queue.acknowledge(result.receipt);
          return { outcome: 'delivered', attempts };
        }
        if (!(result.error instanceof SyntheticTransportFailure))
          return { outcome: 'paused', attempts, reason: 'unconfirmed' };
        if (result.error.kind === 'denied') {
          this.#denied = true;
          return { outcome: 'paused', attempts, reason: 'denied' };
        }
        if (result.error.kind !== 'transient')
          return { outcome: 'paused', attempts, reason: 'unconfirmed' };
        if (attempts === this.#attempts)
          return { outcome: 'paused', attempts, reason: 'retry_exhausted' };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              this.#wake = undefined;
              resolve();
            },
            Math.min(30000, this.#backoff * 2 ** (attempts - 1)),
          );
          this.#wake = () => {
            clearTimeout(timer);
            this.#wake = undefined;
            resolve();
          };
        });
        if (this.#stopped)
          return { outcome: 'paused', attempts, reason: 'stopped' };
      }
      return { outcome: 'paused', attempts, reason: 'retry_exhausted' };
    } catch (error) {
      return {
        outcome: 'paused',
        attempts,
        reason:
          error instanceof AttendanceQueueError &&
          error.code === 'INVALID_RECEIPT'
            ? 'invalid_receipt'
            : 'storage_unavailable',
      };
    } finally {
      this.#running = false;
    }
  }
}
