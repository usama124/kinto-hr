# Synthetic delivery/retry coordinator — 9 October 2026

Status: trusted fixture orchestration only. P02-01/P02-02 and production acceptance remain incomplete.

## Implemented

`scripts/lib/synthetic-attendance-delivery.ts` adds one bounded asynchronous batch exercise over the existing durable queue and a caller-supplied trusted fixture transport. It accepts only local-test mode outside production. It contains no HTTP endpoint/client, credential storage, device SDK, polling cursor, scheduler or host daemon. Existing machine credentials remain heartbeat-only and live uploads remain unavailable.

Each explicit `deliver()` freezes or resumes one persisted queue batch. No pending records returns idle; later captures await another explicit delivery. Callbacks receive an isolated copy of the same frozen envelope plus an AbortSignal. Retry never changes batch/event UUIDs, order or input. A completely matching receipt must commit through the existing atomic queue acknowledgement before delivery is reported reconciled. A reconciled batch may include held server rejections; it does not mean every record was stored or counted as attendance.

Only `SyntheticTransportFailure('transient')` authorizes bounded automatic retry. Defaults are three attempts, a five-second attempt timeout and 250 ms exponential waits; limits are five attempts, 30-second attempt timeout and waits capped at 30 seconds. Arbitrary exceptions/diagnostics pause as unconfirmed without exposing their text or automatically inferring retry/authority. Explicit denial is terminal for that coordinator instance. A new trusted fixture exercise must acquire fresh server authority; constructing a coordinator alone grants no authority.

Timeout aborts the attempt and pauses for explicit reconciliation. A transport that ignores cancellation remains unsettled: another call on that instance is busy until it settles. Late success/failure cannot acknowledge anything and cannot create an unhandled rejection. Stop aborts delivery or wakes backoff promptly, keeps the queue intact and prevents reuse. Transports must honor cancellation for actual resource shutdown; this helper cannot force a network callback to release its resources. Timers/listeners are removed on each exit.

Malformed/foreign/incomplete receipts and local queue failures pause without advancing the frozen request. Held records remain excluded from automatic selection and still require explicit unchanged queue retry. Limits, stop/denial state and backoff are per instance/in memory; durable request/receipt state is in SQLite. There is no persisted retry schedule, jitter, cross-process delivery lease or cryptographic receipt authentication. Distinct coordinator instances can attempt the same frozen request; server idempotency and queue receipt validation remain necessary, not a claim of globally exclusive delivery.

## Verification

15 new unit tests cover idle/held queues, one-batch behavior, immutable retries/backoff limits, unknown errors, terminal denial, uncooperative timeouts, late replies, no overlapping instance attempts, stop/backoff cancellation, malformed receipts, local storage/receipt-write failure, transport mutation and production/configuration guards.

Two new PostgreSQL/SQLite integration cases cover server commit followed by an uncertain lost ACK, explicit retry returning the original receipt without extra raw event/batch/outbox, fresh server permission after a denied exercise, and source conflicts remaining held without automatic retry. These use trusted direct synthetic inbox callbacks, not network or device uploads.

Final verification passed 308 unit/API tests and 255 integration tests, plus formatting, lint, typechecking, coverage thresholds, documentation links and readiness-manifest integrity. Production acceptance remains false. No PostgreSQL schema/grants/migrations, production API/worker/web source or machine permissions changed. Browser/provider acceptance, service builds and migration/schema/recovery drills are not claimed as rerun for this scripts-only increment. Real K50 behavior, power loss, customer networking, secure credential lifecycle and production admission remain unaccepted.

Next bounded work: synthetic inbox exception review and mapping-resolution preparation. Source/reset/clock proof, approved K50 runtime/distribution, protected credentials, production admission/rotation, safe reprocessing and finalized-period safeguards still gate live attendance. Normalization, leave accounting, period locking and payroll remain separate work.
