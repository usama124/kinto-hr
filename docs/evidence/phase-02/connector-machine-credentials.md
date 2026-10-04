# Internal connector credentials — 4 October 2026

## Scope and release boundary

This increment implements synthetic, internal enrollment redemption and revocable, digest-only connector credentials. `LocalMachineAuthority` deliberately requires loopback `kinto_test*` PostgreSQL, a separate Redis database (2–15), and an explicit namespace. It is not registered in AppModule and has no HTTP endpoints. No production machine admission, heartbeat handler, attendance upload, device activation, credential rotation, connector installation or actual K50 communication is claimed. Existing public enrollment tokens remain preparatory and cannot be redeemed by this authority; public responses still report machine access unavailable.

P02-01 remains partial. Before mounting machine endpoints, implement an approved production admission-store lifecycle, explicit stable namespace/generation configuration, transport/rate limits, tenant owner credential/enrollment workflow, lost-response reconciliation, and security/operational review. OS-protected connector secret storage, hardware/SDK identity evidence, event ingestion and later attendance/leave/payroll remain pending.

## Persistence and admission

New bound tokens retain the 15-minute, one-time secret and exact-request metadata-only replay semantics. A generation digest binds each token to external admission state. Existing unbound tokens cannot acquire that binding through a retry. Redemption rechecks the issuing owner's authority, active company/base subscription, current allocation version, original draft device version and active branch. It converts a reservation into one credential/device slot under the shared tenant allocation lock. Active unexpired credentials and live reservations both count against device and connector limits; allocation reductions cannot strand current usage. Duplicate redemption cannot create multiple credentials. Expiry or revocation releases capacity without deleting history.

Credentials contain 32 random bytes (`kc1_`), are returned only in the initial successful internal redemption response and persist only as SHA-256 digests. Their fixed 30-day lifetime is an internal boundary, not a promise of automatic renewal. Safe metadata has `scope: heartbeat_only` and `attendanceIngestionAvailable: false`; this scope does not implement an actual heartbeat endpoint. No serial, browser session or token metadata grants machine authority. Owner/HR can read internal metadata; revocation requires owner authority and MFA. Foreign keys bind credential, enrollment and device to the same company. SQL storage and projection helpers are denied directly to application/worker/dispatcher roles. The control owner has column-only mutation grants; audit/outbox references never include credentials or digests.

PostgreSQL candidate reads are explicitly persistence primitives, not machine authorization. `LocalMachineAuthority` requires BOTH the SQL candidate and an exact positive Redis permit. Permits are never reconstructed from database rows. The external generation is created with SET NX; losing it creates a different generation and denies old credentials and pending tokens. This security state must never be restored together with an older PostgreSQL backup. Restoring external state, individual marker eviction/loss, or changing namespace configuration is outside this local proof and requires an approved production incident procedure. Production must prevent individual key eviction and treat uncertain admission-state integrity as generation invalidation, not recover missing seals from PostgreSQL.

The consumed-token marker is written before SQL, so a database failure, lost response, retry or older database row cannot make the token usable again. A positive credential permit is created with SET NX only after SQL commits. Revocation writes an external tombstone BEFORE SQL; late redemption cannot overwrite it. Redis errors fail closed with no SQL-only fallback. Marker TTLs cover the original token/credential lifetime. Revocation retries retain one audit/outbox mutation. The legacy SQL-only enrollment revoke path rejects bound tokens, which must pass through the external seal boundary.

A failed or lost redemption response never re-discloses/replaces the credential. A failed post-commit permit grant leaves a non-admitted credential occupying capacity; the owner must inspect metadata, revoke it and issue a new token. Generation loss denies old tokens; they still occupy reservations until expiry or explicit revocation. A stale database backup may display an active credential while external admission rejects it; this is intentional fail-closed recovery behavior.

## Verification

Recorded checks are local synthetic evidence, not production acceptance:

- `pnpm verify`: formatting/lint/type checks, 221 unit/API tests across 32 files, coverage thresholds and readiness-manifest integrity. Coverage: 97.64% statements, 93.66% branches, 100% functions, 97.99% lines.
- `pnpm test:schema-isolation`: exact classification and forced RLS for 47 business tables.
- `pnpm test:recovery`: full synthetic database snapshot/restore includes bound redeemed tokens and active credentials. Revocation performed after the PostgreSQL backup survives restoration of an old active credential through the independent Redis tombstone. Original token replay remains denied; credential/enrollment events are consumed once. Private report: `.local/recovery/7b2e58268bae472d98c5d133756fd231/report.json`.

- `pnpm test:integration`: 228 tests across 20 files, including 19 added internal connector scenarios in the existing device suite.
- `pnpm test:migrations`: all 53 migrations passed clean-baseline, upgrade/backfill, replay and tenant delivery isolation.
- `pnpm build`: API/web/worker builds passed.
- `pnpm test:worker:runtime`: all four built worker/monitor startup/shutdown checks passed.

- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 116 existing desktop/mobile browser regressions passed; these do not claim a connector UI or machine endpoint.
- Final targeted device suite: all 33 scenarios passed, including competing authority instances sharing one external namespace.
- `git diff --check`: passed. Planning links/readiness integrity checked; no production acceptance inferred.

No provider, hardware, remote CI, staging or production approval is claimed. Foundation readiness remains `productionAccepted: false`.

Tests extend the existing device integration suite: successful binding/digest storage, metadata-only retry, token concurrency, stale-row consumption/revocation, grant-versus-tombstone ordering, lost external state, Redis outage, quota preservation/release, failed audit rollback, role isolation, and fresh company/subscription/device/branch/expiry checks. Constructor safety restrictions and no public route registration limit this work to synthetic internal exercises.

The resumed draft initially failed Prisma validation because the composite one-to-one enrollment relation needed a matching composite unique key; schema and the new migration now agree. The permit revocation draft originally deleted Redis keys; it was changed to a tombstone plus SET NX to prevent a late post-commit grant. Tests exercise this ordering. Initial integration failures were corrected synthetic fixtures (valid allocation reasons, ended subscription field and a changed allocation rather than a prohibited no-op). No published migration was edited and no existing business data reset.
