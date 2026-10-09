import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  attendanceAdapterVersionSchema,
  attendanceBatchEnvelopeSchema,
  attendanceBatchReceiptSchema,
  attendanceSourceEventSchema,
  ATTENDANCE_BATCH_MAX_BYTES,
  ATTENDANCE_BATCH_MAX_EVENTS,
  type AttendanceBatchReceipt,
} from '@kinto/contracts';

const bindingSchema = z.strictObject({
  tenantId: z.uuid().toLowerCase(),
  connectorId: z.uuid().toLowerCase(),
  deviceId: z.uuid().toLowerCase(),
  adapterVersion: attendanceAdapterVersionSchema,
});
const batchSchema = attendanceBatchEnvelopeSchema.extend({
  events: attendanceSourceEventSchema
    .array()
    .min(1)
    .max(ATTENDANCE_BATCH_MAX_EVENTS),
});
type Binding = z.infer<typeof bindingSchema>;
type Batch = z.infer<typeof batchSchema>;
type Options = {
  mode: 'local_test';
  directory: string;
  binding: Binding;
  maxRecords?: number;
  maxPayloadBytes?: number;
};
type Row = Record<string, unknown>;
type State = {
  version: number;
  binding: string;
  max_records: number;
  max_bytes: number;
  active_batch: string | null;
  last_receipt: string | null;
};
export class AttendanceQueueError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'STORAGE_UNAVAILABLE'
      | 'CORRUPT'
      | 'BINDING_MISMATCH'
      | 'INVALID_CAPTURE'
      | 'TRANSPORT_CONFLICT'
      | 'QUEUE_FULL'
      | 'INVALID_RECEIPT'
      | 'INVALID_STATE',
  ) {
    super(code);
  }
}

/** Synthetic POSIX fixture queue. No credentials, SDK, network transport or live service. */
export class SyntheticAttendanceQueue {
  readonly #db: DatabaseSync;
  readonly #binding: Binding;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  #closed = false;
  constructor(options: Options) {
    if (
      options.mode !== 'local_test' ||
      process.env.NODE_ENV === 'production' ||
      process.platform === 'win32'
    )
      throw new AttendanceQueueError('UNAVAILABLE');
    this.#binding = bindingSchema.parse(options.binding);
    this.#maxRecords = z
      .number()
      .int()
      .min(1)
      .max(2000)
      .parse(options.maxRecords ?? 2000);
    this.#maxBytes = z
      .number()
      .int()
      .min(1024)
      .max(5_000_000)
      .parse(options.maxPayloadBytes ?? 1_000_000);
    let db: DatabaseSync | undefined;
    try {
      if (!isAbsolute(options.directory))
        throw new AttendanceQueueError('UNAVAILABLE');
      const directory = resolve(options.directory);
      // Refuse symlinks in every existing path component before any creation.
      let ancestor = directory;
      while (ancestor !== parse(ancestor).root) {
        if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink())
          throw new AttendanceQueueError('UNAVAILABLE');
        ancestor = dirname(ancestor);
      }
      const created = !existsSync(directory);
      if (created) mkdirSync(directory, { mode: 0o700 });
      const stat = lstatSync(directory);
      if (
        !stat.isDirectory() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        realpathSync(directory) !== directory
      )
        throw new AttendanceQueueError('UNAVAILABLE');
      // The parent must already exist. Sync new directory metadata before any
      // committed capture can be reported; this is still a synthetic POSIX proof.
      for (const path of created
        ? [dirname(directory), directory]
        : [directory]) {
        const fd = openSync(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      const filename = join(directory, 'synthetic-attendance.sqlite');
      for (const suffix of ['-journal', '-wal', '-shm']) {
        try {
          const sidecar = lstatSync(filename + suffix);
          if (
            !sidecar.isFile() ||
            sidecar.nlink !== 1 ||
            (sidecar.mode & 0o077) !== 0 ||
            sidecar.uid !== process.getuid?.()
          )
            throw new AttendanceQueueError('UNAVAILABLE');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      let fd: number;
      try {
        fd = openSync(
          filename,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        fd = openSync(filename, constants.O_RDWR | constants.O_NOFOLLOW);
      }
      try {
        const file = fstatSync(fd);
        if (
          !file.isFile() ||
          file.nlink !== 1 ||
          (file.mode & 0o077) !== 0 ||
          file.uid !== process.getuid?.()
        )
          throw new AttendanceQueueError('UNAVAILABLE');
      } finally {
        closeSync(fd);
      }
      db = new DatabaseSync(filename);
      db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;',
      );
      this.#db = db;
      this.#transaction(() => {
        db!.exec(`CREATE TABLE IF NOT EXISTS queue_state (
          id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1),binding TEXT NOT NULL,
          max_records INTEGER NOT NULL,max_bytes INTEGER NOT NULL,active_batch TEXT,last_receipt TEXT);
          CREATE TABLE IF NOT EXISTS records (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','acknowledged','held')),reject_code TEXT);`);
        db!
          .prepare(
            'INSERT OR IGNORE INTO queue_state(id,version,binding,max_records,max_bytes) VALUES(1,1,?,?,?)',
          )
          .run(JSON.stringify(this.#binding), this.#maxRecords, this.#maxBytes);
        this.#state();
        const rows = db!
          .prepare(
            'SELECT event_id,payload,status,reject_code FROM records ORDER BY sequence',
          )
          .all() as Row[];
        for (const row of rows) {
          const event = attendanceSourceEventSchema.parse(
            JSON.parse(String(row.payload)),
          );
          if (
            event.connectorEventId !== row.event_id ||
            !['pending', 'acknowledged', 'held'].includes(String(row.status)) ||
            (row.status === 'held'
              ? ![
                  'invalid_event',
                  'duplicate_transport_id',
                  'source_identity_missing',
                  'source_identity_conflict',
                  'transport_identity_conflict',
                ].includes(String(row.reject_code))
              : row.reject_code !== null)
          )
            throw new AttendanceQueueError('CORRUPT');
        }
        this.#capacity();
      });
    } catch (error) {
      db?.close();
      if (error instanceof AttendanceQueueError) throw error;
      throw new AttendanceQueueError('STORAGE_UNAVAILABLE');
    }
  }
  close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
  #transaction<T>(operation: () => T): T {
    if (this.#closed) throw new AttendanceQueueError('UNAVAILABLE');
    let begun = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          /* Keep original failure; no acknowledgement. */
        }
      }
      if (error instanceof AttendanceQueueError) throw error;
      throw new AttendanceQueueError('STORAGE_UNAVAILABLE');
    }
  }
  #state() {
    const state = this.#db
      .prepare('SELECT * FROM queue_state WHERE id=1')
      .get() as State | undefined;
    if (!state || state.version !== 1)
      throw new AttendanceQueueError('CORRUPT');
    if (
      state.binding !== JSON.stringify(this.#binding) ||
      state.max_records !== this.#maxRecords ||
      state.max_bytes !== this.#maxBytes
    )
      throw new AttendanceQueueError('BINDING_MISMATCH');
    if (state.active_batch) {
      let batch: Batch;
      try {
        batch = batchSchema.parse(JSON.parse(state.active_batch));
      } catch {
        throw new AttendanceQueueError('CORRUPT');
      }
      if (
        batch.deviceId !== this.#binding.deviceId ||
        batch.adapterVersion !== this.#binding.adapterVersion ||
        new Set(batch.events.map((e) => e.connectorEventId)).size !==
          batch.events.length
      )
        throw new AttendanceQueueError('CORRUPT');
      for (const event of batch.events) {
        const row = this.#db
          .prepare('SELECT payload,status FROM records WHERE event_id=?')
          .get(event.connectorEventId) as Row | undefined;
        if (
          !row ||
          row.status !== 'pending' ||
          row.payload !== JSON.stringify(event)
        )
          throw new AttendanceQueueError('CORRUPT');
      }
    }
    if (state.last_receipt) {
      try {
        attendanceBatchReceiptSchema.parse(JSON.parse(state.last_receipt));
      } catch {
        throw new AttendanceQueueError('CORRUPT');
      }
    }
    return state;
  }
  #capacity() {
    const usage = this.#db
      .prepare(
        'SELECT count(*) AS records,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM records',
      )
      .get()! as Row;
    if (
      Number(usage.records) > this.#maxRecords ||
      Number(usage.bytes) > this.#maxBytes
    )
      throw new AttendanceQueueError('QUEUE_FULL');
  }
  capture(input: unknown) {
    const parsed = attendanceSourceEventSchema
      .array()
      .min(1)
      .max(ATTENDANCE_BATCH_MAX_EVENTS)
      .safeParse(input);
    if (!parsed.success) throw new AttendanceQueueError('INVALID_CAPTURE');
    return this.#transaction(() => {
      this.#state();
      let inserted = 0;
      for (const event of parsed.data) {
        const payload = JSON.stringify(event);
        const prior = this.#db
          .prepare('SELECT payload FROM records WHERE event_id=?')
          .get(event.connectorEventId) as Row | undefined;
        if (prior) {
          if (prior.payload !== payload)
            throw new AttendanceQueueError('TRANSPORT_CONFLICT');
          continue;
        }
        this.#db
          .prepare(
            "INSERT INTO records(event_id,payload,status) VALUES(?,?,'pending')",
          )
          .run(event.connectorEventId, payload);
        inserted++;
      }
      this.#capacity();
      return { inserted };
    });
  }
  nextBatch(): Batch | null {
    return this.#transaction(() => {
      const state = this.#state();
      if (state.active_batch)
        return batchSchema.parse(JSON.parse(state.active_batch));
      const events = this.#db
        .prepare(
          "SELECT payload FROM records WHERE status='pending' ORDER BY sequence LIMIT 500",
        )
        .all()
        .map((row) =>
          attendanceSourceEventSchema.parse(
            JSON.parse(String((row as Row).payload)),
          ),
        );
      if (!events.length) return null;
      const batch = batchSchema.parse({
        batchId: randomUUID(),
        schemaVersion: 1,
        deviceId: this.#binding.deviceId,
        adapterVersion: this.#binding.adapterVersion,
        events,
      });
      if (Buffer.byteLength(JSON.stringify(batch)) > ATTENDANCE_BATCH_MAX_BYTES)
        throw new AttendanceQueueError('QUEUE_FULL');
      this.#db
        .prepare('UPDATE queue_state SET active_batch=? WHERE id=1')
        .run(JSON.stringify(batch));
      return batch;
    });
  }
  acknowledge(input: unknown) {
    const parsed = attendanceBatchReceiptSchema.safeParse(input);
    if (!parsed.success) throw new AttendanceQueueError('INVALID_RECEIPT');
    const receipt = parsed.data;
    return this.#transaction(() => {
      const state = this.#state();
      if (!state.active_batch) {
        if (state.last_receipt === JSON.stringify(receipt)) return;
        throw new AttendanceQueueError('INVALID_RECEIPT');
      }
      const batch = batchSchema.parse(JSON.parse(state.active_batch));
      if (
        receipt.batchId !== batch.batchId ||
        receipt.deviceId !== batch.deviceId ||
        receipt.events.length !== batch.events.length ||
        receipt.events.some(
          (e, i) => e.connectorEventId !== batch.events[i].connectorEventId,
        )
      )
        throw new AttendanceQueueError('INVALID_RECEIPT');
      for (const event of receipt.events) {
        const rejected = event.disposition === 'rejected_unstored';
        this.#db
          .prepare('UPDATE records SET status=?,reject_code=? WHERE event_id=?')
          .run(
            rejected ? 'held' : 'acknowledged',
            rejected ? event.code : null,
            event.connectorEventId!,
          );
      }
      this.#db
        .prepare(
          'UPDATE queue_state SET active_batch=NULL,last_receipt=? WHERE id=1',
        )
        .run(JSON.stringify(receipt));
    });
  }
  retryHeld(input: unknown) {
    const parsed = z
      .uuid()
      .toLowerCase()
      .array()
      .min(1)
      .max(ATTENDANCE_BATCH_MAX_EVENTS)
      .safeParse(input);
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length)
      throw new AttendanceQueueError('INVALID_STATE');
    this.#transaction(() => {
      this.#state();
      for (const id of parsed.data) {
        const row = this.#db
          .prepare('SELECT status FROM records WHERE event_id=?')
          .get(id) as Row | undefined;
        if (row?.status !== 'held')
          throw new AttendanceQueueError('INVALID_STATE');
        this.#db
          .prepare(
            "UPDATE records SET status='pending',reject_code=NULL WHERE event_id=?",
          )
          .run(id);
      }
    });
  }
  summary() {
    return this.#transaction(() => {
      const state = this.#state();
      const counts = { pending: 0, acknowledged: 0, held: 0 };
      for (const row of this.#db
        .prepare('SELECT status,count(*) AS total FROM records GROUP BY status')
        .all() as Row[]) {
        if (!(String(row.status) in counts))
          throw new AttendanceQueueError('CORRUPT');
        counts[row.status as keyof typeof counts] = Number(row.total);
      }
      return {
        ...counts,
        activeBatchId: state.active_batch
          ? batchSchema.parse(JSON.parse(state.active_batch)).batchId
          : null,
      };
    });
  }
  lastReceipt(): AttendanceBatchReceipt | null {
    return this.#transaction(() => {
      const state = this.#state();
      return state.last_receipt
        ? attendanceBatchReceiptSchema.parse(JSON.parse(state.last_receipt))
        : null;
    });
  }
}
