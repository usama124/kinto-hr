# Connector enrollment token issuance and capacity reservations

Date: 4 October 2026. Starting main: `1d1bfe6` (PR 64). Branch: `codex/connector-enrollment-reservations`.

## Implemented scope

This bounded P02-01 increment adds preparatory owner-issued enrollment tokens and reservations. It does **not** implement redemption, machine credentials, a connector installer, device activation or attendance ingestion. Every response still reports machine access unavailable; an issued token is not yet usable by a machine.

Tenant endpoints:

- `POST /api/v1/tenants/{tenantId}/connectors/enrollment-tokens`: current selected-company session, recent MFA, exact origin/CSRF, UUID `Idempotency-Key` and fresh owner authority. Strict body: `deviceId`, `expectedDeviceVersion`, `expectedAllocationVersion` only. Requires an active company/base subscription, enabled current allocation, a matching draft device version and active branch.
- `GET` at the same path: owner/HR metadata-only history, bounded ID-keyset pagination (`limit` defaults to 25, maximum 50; optional `afterId`). No token, digest, issuer or request key is projected.
- `POST /api/v1/tenants/{tenantId}/connectors/enrollment-tokens/{id}/revocation`: fresh owner/MFA/CSRF with `{expectedVersion: 1}`. Repeating revocation returns the retained version-2 record without another audit/outbox write. Historical cleanup remains possible without a current base subscription while company/owner access is still active.

The server generates 32 random bytes with Node crypto, prefixed `ke1_`, and persists only a SHA-256 verification digest. Created/expires timestamps are server-derived with a fixed 15-minute lifetime. The token is disclosed only in the initial successful issuance response, which inherits the API's no-store headers. An exact request replay returns metadata and `token: null`, never a replacement secret or extended expiry. Altering the device/version scope under the same actor/company/request key conflicts. Fresh authorization is checked even for old receipts. If the original response was lost, reconcile the same request to learn its record ID, revoke it and issue a new request; a plaintext secret cannot be recovered. Never put tokens in URLs, logs, browser storage or Git.

One token reserves one distinct draft device and one prospective connector. All issuance, revocation and allocation changes share the existing tenant attendance-allocation lock. Simultaneous final-slot requests have one winner. Only issued, unexpired rows count; expiry releases capacity by server time without a cleanup job, and revocation releases it immediately. A device cannot have two live reservations. Allocation changes cannot reduce either limit below live reservations, including disabling; revoke pending reservations first or wait for expiry. Operator request replay remains historical and cannot restore capacity or tokens. Existing employee seats, billing models and all plan defaults remain unchanged.

The new forced-RLS table is private even to ordinary tenant context. Application, worker and dispatcher roles have no direct table access, and the internal projection function is not granted to them. The control owner has SELECT/INSERT plus column-only UPDATE of status/version/revoked timestamp; it cannot change a token digest, binding, expiry or retry identity or delete history. Tenant/device and tenant/allocation-version foreign keys prevent cross-company binding. Audit and outbox writes commit atomically with issuance/revocation and contain fixed reasons/record references, never plaintext or digest. The worker observes enrollment-change events exactly once; it does not authenticate machines or read token records.

Device retirement or metadata changes do not erase reservations or history. A pending reservation retains its original device/version binding until expiry or explicit revocation; future redemption must recheck current device/branch/allocation state and cannot trust old inventory metadata. The initial one-device/one-connector reservation model is not a commercial promise about final multi-device connector behavior.

## Verification

Local checks passed:

- `pnpm verify`: formatting, lint, type checks, 219 unit/API tests across 31 files, coverage thresholds, 10 planning documents/181 local links and readiness-manifest integrity. Overall coverage: 97.6% statements, 93.51% branches, 100% functions and 97.96% lines. New enrollment contracts are fully covered.
- `pnpm test:integration`: all 209 tests across 20 files, including eight added enrollment scenarios and existing employee/allocation regressions.
- `pnpm test:schema-isolation`: exact forced-RLS/table/column classification for 46 business tables.
- `pnpm test:migrations`: all 52 migrations; clean baseline, upgrade/backfill, replay and tenant delivery isolation passed.
- `pnpm test:recovery`: live/revoked enrollment history, digest-only snapshots, non-secret exact retries and three enrollment events consumed once. Private report: `.local/recovery/0fb2915023984188ac27c58fe2186ab7/report.json`.
- `pnpm build`: API/web/worker builds passed.
- `pnpm test:worker:runtime`: all four built worker/monitor startup/shutdown checks passed.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 116 existing desktop/mobile browser regressions passed. No enrollment UI is claimed by these tests.
- `git diff --check`: passed.

Foundation readiness remains `productionAccepted: false`. Provider/Keycloak and K50 hardware tests were not rerun; no provider or UI behavior changed, and no real device communication was added. No remote CI or production approval is claimed.

New database journeys extend the existing device integration suite and cover exact concurrent issuance, non-replayed secrets/digest storage, changed-key conflict, owner/MFA/revocation rechecks, private role/column grants, both capacity dimensions, issuance-versus-disable races, revocation/expiry release, stale versions, retired/inactive devices, pagination, cross-company scope and audit-failure rollback. Contract tests cover strict inputs, state/lifetime coherence and secret-free replay/projection. HTTP tests cover session/company/CSRF/origin/idempotency boundaries and server-derived MFA/actor context.

The initial targeted database run exposed incorrectly grouped bootstrap grant arguments; the statements were separated and local bootstrap rerun. Permission classification and the full database rerun then passed. Two test fixtures were corrected: retirement must retain the original firmware, and the audit-failure assertion must match PostgreSQL error code `23505` as wrapped by Prisma. The first recovery run caught the intentionally explicit old table count (45); it was updated to 46 with the new table, whitelist, full snapshot and live/revoked fixtures. No published migration was edited or existing business data reset.

Recovery preserves verification digests, binding/version/lifetime, live/revoked history and exact request receipts without disclosing/restoring plaintext. Enrollment outbox events are consumed once on repeated delivery. This synthetic metadata restore is not approval to resurrect pending bearer tokens after a real incident. Before redemption is enabled, implement a fail-closed recovery generation/epoch or invalidate all outstanding enrollment/machine credentials after restoration. Production secret transport, key/credential operations, retention and incident response still need review.

## Next and release boundary

Next: single-use redemption and revocable machine credentials, converting reservations to bounded actual connector/device usage under the same lock. Recheck tenant/subscription/allocation and current device/version/branch, reject expired/revoked/reused tokens, define lost-credential-response recovery, and prevent old backups from reviving credentials. Add credential rotation/revocation and then the owner enrollment workspace/local service. Machine authentication must never derive authority from browser sessions, device serials or draft inventory alone. K50/firmware/SDK/reset-identity evidence, OS-protected host secret storage, durable ingestion, mappings, shifts/leaves, payroll and foundation production gates remain pending. P02-01 remains partial.
