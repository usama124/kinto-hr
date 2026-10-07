# Synthetic durable connector queue — 8 October 2026

Status: internal POSIX fixture only. P02-01/P02-02 and production acceptance remain incomplete.

## Implemented

`scripts/lib/synthetic-attendance-queue.ts` uses the existing pinned Node 22 runtime and its experimental `node:sqlite` module. This is not a selected K50 SDK/service runtime or a Windows installer. The constructor requires `local_test`, non-production NODE_ENV and an absolute private directory with an existing parent. It creates directories/files with 0700/0600 permissions, checks ownership, refuses symlink ancestors/database files and hard-linked databases/unsafe existing SQLite sidecars, and synchronizes new directory metadata. Credentials, enrollment tokens, templates and photos have no persistence fields. Existing Git ignore rules already exclude SQLite databases, journals and `.local` runtime data.

SQLite uses DELETE journaling, FULL synchronization, trusted-schema restrictions and a bounded busy timeout. Capture, batch freezing and receipt application each use an immediate transaction. A successful capture return follows commit; a storage or capacity failure reports no capture success. Acknowledgement status, held rejection codes, active-batch clearing and the last receipt commit together. No in-memory checkpoint is treated as durable. Private filesystem access is required; this does not claim encrypted storage, tamper resistance against the host owner, power-loss acceptance on customer disks or protection after directory ownership/permissions are changed externally.

A queue is permanently bound to company, fixture connector UUID, device, adapter version and capacity settings. Capture accepts strict sanitized source events and preserves exact string IDs/local timestamps. Repeated transport UUIDs with identical canonical input are local no-ops; changed input conflicts and rolls the entire capture back. Distinct transports at the same timestamp remain separate. Queue admission does not prove device source identity or hardware compatibility. Rebinding/transferring pending data after connector replacement is not implemented; restart evidence uses the same fixture binding, not renewed machine credentials.

## Batches and receipts

There is one persisted immutable active batch, containing up to 500 records and no more than the shared 1 MB envelope limit. New captures wait outside the frozen batch. Restart, timeout or missing ACK never changes its batch ID, transport UUIDs, order or payload. There is no network transport, credential authentication, device cursor, SDK polling or automatic retry loop in this increment.

The caller must provide a receipt from a trusted synthetic server exercise. Shape matching alone is not cryptographic server authentication. Receipt application requires matching batch/device, complete ordered indexes and matching transport UUIDs for every entry, including rejections. Partial, malformed, reordered, foreign or unidentified replies acknowledge nothing. `stored`, `duplicate` and durably `quarantined` dispositions mark local records acknowledged; `rejected_unstored` retains the original payload in held status. Existing server fixtures always quarantine newly accepted events, so local acknowledgement does not mean counted attendance.

Exact replay of the most recently applied receipt is a no-op when no new batch is active. A stale receipt cannot reconcile a newer active batch. Held records are excluded from automatic batch selection; explicit all-or-nothing `retryHeld` preserves their original UUID/payload and creates a new batch later. There is no silent deletion, payload editing or automatic rejection retry.

The fixture retains acknowledged payloads/UUIDs and held records. Default bounds are 2,000 retained records and 1 MB of sanitized payload bytes; configurable bounds cannot exceed 2,000 records/5 MB. These are logical retained-data bounds, not a promise about physical SQLite file size. Exhaustion fails closed without pruning records. Production retention/compaction, disk-pressure telemetry and capacity planning remain unimplemented.

## Verification

22 new queue unit tests cover private files/binding, unsafe input, transport conflicts, bounded batches/capacity, receipt validation/replay, held retry rollback, failed receipt persistence, abrupt committed/uncommitted subprocess termination, concurrent processes and corrupted storage. Actual subprocess tests required execution outside the restricted sandbox; sandbox EPERM failures were not counted as crash recovery evidence.

Three new synthetic queue/PostgreSQL inbox integration cases cover server commit followed by a lost ACK/local restart, denied uploads preserving the frozen request, source-identity re-poll duplicates and rejected source conflicts retained across restart/explicit unchanged retry. No duplicate canonical server event is added by exact retry or proven-source fixture re-poll.

Complete regression passed 293 unit/API tests and 253 integration tests, together with formatting, lint, typechecking, coverage thresholds, documentation links and readiness-manifest integrity. Production acceptance remains false. No production API, worker, web UI, machine credential, PostgreSQL schema or migration changes in this increment. Browser/provider acceptance, schema/migration/recovery drills and service builds are not claimed as rerun. Queue crash tests exercise local process termination and SQLite rollback, not real hardware power failure, full disks, network delivery, independently restored customer machines or encrypted secret recovery.

Next bounded work: synthetic delivery/retry coordination over trusted fixtures. Live uploads still require K50/SDK/source-ID/reset evidence, approved service/distribution, protected credentials, production admission/rotation and mapping reprocessing/finalized-period safety. Normalization, leave accounting, period locking and payroll remain separate work.
