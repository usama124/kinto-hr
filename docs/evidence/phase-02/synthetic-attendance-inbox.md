# Synthetic durable attendance inbox — 7 October 2026

Status: internal local preparation only. P02-01/P02-02 remain partial; production acceptance is false.

## Implemented boundary

`SyntheticAttendanceInbox` is an internal API-package fixture tool, not an HTTP endpoint. Construction rejects production NODE_ENV, remote databases and names outside `kinto_test*`; SQL independently refuses ordinary database names. Every call requires current company owner membership and MFA through the constrained organization authority. HR/employees/foreign owners cannot author or replay fixtures. A connector UUID here is a fixture namespace, not a credential, registered connector or hardware identity. Existing machine credentials remain heartbeat-only; attendance ingestion stays unavailable.

Migration 55 adds three private forced-RLS append-only tables for canonical sanitized events, transport aliases and batch receipts. Ordinary app/worker/dispatcher roles cannot read or mutate them directly; only the app can execute the constrained fixture function. Source timestamps remain local strings, with no conversion, attendance classification or employee assignment.

The function atomically writes accepted raw records, aliases, ordered receipt, static audit and observer outbox fact. There is no successful acknowledgement before the SQL command commits. Audit or outbox failure rolls the whole command back. Workers observe the committed fact once but receive no raw attendance access or payroll effect.

## Retry and duplicate behavior

Transport identity is company/fixture connector/event UUID. Synthetic proven-source fixture identity is company/device/reset epoch/vendor event ID, independent of connector UUID. Exact batch-key retries return the original receipt UUID and dispositions, including after restarting the fixture class or restoring PostgreSQL. Changed sanitized input/device under that key conflicts. Overlapping/concurrent batches, full re-polls and connector replacement reuse canonical records when fixture source identity proves sameness. Different source IDs at the same timestamp and different reset epochs remain distinct. Unverified IDs never deduplicate distinct transports by timestamp or claimed vendor ID.

New records always return `quarantined / source_identity_unverified`, even with proven-source fixture keys: these keys test an algorithm, not K50 firmware. A duplicate means an existing durably quarantined canonical record, not counted attendance. Conflicting transport/source content returns `rejected_unstored` without replacing the canonical event or creating an alias. Rejected records must remain queued by a future connector; a receipt is not permission to discard them.

Preflight limits batches to 500 records/1 MB and permits only source attendance fields. Invalid payloads, photos and templates are not saved, logged or hashed into receipts. Receipts retain only their static rejection codes, indexes and validated transport UUIDs. Exact replay compares sanitized semantic packets, not invalid raw bytes: changing only ignored invalid payload fields leaves the original receipt unchanged. SQL also rejects injected fields when called without TypeScript preflight. There is no mounted HTTP body-byte/rate-limit claim for this tool.

## Verification

Local verification: 271 unit/API tests; 250 integration tests, including 13 new inbox cases; 52-table schema isolation; clean baseline/upgrade/replay across 55 migrations; API/web/worker builds; 4 built-worker runtime tests. Formatting, lint, typechecking, coverage thresholds, documentation links and readiness-manifest integrity pass. Existing browser and provider acceptance tests were not rerun for this internal backend-only increment; no UI or public HTTP route changed.

The isolated dump/restore drill preserved all three inbox tables and exact receipt replay, denied direct runtime reads and observed the restored inbox fact once. Private evidence: `.local/recovery/a07bc7a0bc6748659f78759b51031707/report.json`. This proves a synthetic SQL restore on the existing local cluster, not independent-cluster recovery, PITR, local connector queue recovery or production machine admission.

Next bounded work: synthetic connector durable capture/queue and explicit receipt reconciliation. Live uploads still require actual K50/SDK/source-ID/reset proof, approved runtime/distribution, OS-protected credentials, production admission/rotation review, mapping exception reprocessing and finalized-period safeguards. Attendance normalization, leave balances/approvals, period locking and payroll remain separate work.
