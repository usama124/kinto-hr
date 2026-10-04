# Explicit attendance capacity allocations

Date: 4 October 2026. Base main: `3d14a66` (PR 62). The first fetch still showed PR 61, so the local workspace commit was preserved; a later fetch found PR 62 and the feature branch was fast-forwarded after verifying identical code trees. Branch: `codex/attendance-entitlement-controls`.

## Implemented boundary

Migration 51 (`202610040002_attendance_allocations`) adds immutable `attendance_allocations` versions and constrained read/change functions. All 45 business tables are included in the reviewed isolation inventory. The new history/receipt table has forced RLS, only a constrained control-role policy, and SELECT/INSERT grants only to that role. No direct application/worker/dispatcher access, UPDATE or DELETE grant exists. Owner/HR projections never expose operator identity or idempotency request keys.

No commercial device quotas are inferred from employee tiers. All existing Free/Starter/Growth/Business/Scale plans and free/complimentary/manual-paid subscriptions default to disabled attendance with zero device/connector allocations. A platform operator with recent MFA may explicitly allocate positive device/connector capacity, change it with the current allocation version, or disable it using a new zero-capacity version. Integer bounds of 0–1000 are implementation safety bounds, not plan inclusions or prices. No paid service or billing collection is introduced.

Allocation versioning is independent of employee entitlement versioning. Existing immutable plan capabilities, employee seat calculations, subscription mode, complimentary grants and employee override behavior remain unchanged. Both reads and commands require an active company and effective base subscription; company readers also require active owner/HR membership and identity plus recent MFA. Platform authorization is checked afresh, including on retries.

The allocation is immediate, not a dated future grant. History rows retain operator/request ID, expected/new version, limits and fixed reason category. Later pricing/dated allocation packages remain separate work. This allocation does not activate a device, create a connector, approve hardware or grant machine access: `machineAccessAvailable` is always false and all existing inventory records remain draft/retired. No active occupancy/reservation store exists yet. Future enrollment/activation must recheck current allocation and subscription, share the tenant allocation lock, and atomically enforce actual usage before issuing authority; these requirements are not replaced by this public read projection.

## API and retry behavior

- `GET /api/v1/tenants/{tenantId}/attendance-entitlements`: selected-company owner/HR read.
- `GET /api/v1/platform/tenants/{tenantId}/attendance-entitlements`: separate platform-operator read, independent of tenant session selection.
- `PUT /api/v1/platform/tenants/{tenantId}/attendance-entitlements`: operator command with origin/CSRF, recent MFA and UUID `Idempotency-Key`.

Strict command fields are `expectedVersion`, `enabled`, `deviceLimit`, `connectorLimit` and fixed `initial_setup`/`allocation_change`/`disable_attendance` reason. Client actor/tenant authority, arbitrary private reason text and machine-access flags are rejected. Snapshot version zero is unconfigured with null configuration time and zero capacity.

Tenant-scoped locking serializes competing changes. Exactly matching retries return the original ID/version with `replayed: true`, even after newer versions; replay never restores an old allocation. Altered key reuse conflicts, independent concurrent stale commands cannot both advance the version, and no-op changes conflict. Each new version commits tenant audit, platform audit and value-free outbox references atomically. Worker processing records one receipt per `attendance.allocation_changed.v1` event and gains no allocation-table access.

## Verification

Final local checks passed:

- `pnpm verify`: formatting, lint, API/web type checks, 214 unit/API tests across 30 files, coverage thresholds and readiness-manifest integrity. Updated documentation validates 10 planning files/175 local links.
- `pnpm test:integration`: all 201 PostgreSQL/API integration tests across 20 files passed, including five new allocation scenarios extending existing entitlement tests.
- `pnpm test:schema-isolation`: all 45 business tables passed RLS/classification/privilege checks.
- `pnpm test:migrations`: clean baseline, all 51 upgrade migrations, replay/backfill and tenant delivery isolation passed.
- `pnpm test:recovery`: isolated restore and exact old-request replay passed; ignored private report at `.local/recovery/326125898bcc477bb317ffbd1fba0c7a/report.json`.
- `pnpm build`: API, web and worker builds passed.
- `pnpm test:worker:runtime`: all four built worker/runtime tests passed.
- `git diff --check`: passed.

Shared contracts cover default/positive/disabled states and inconsistent limits/reasons; API tests cover session selection, platform-vs-company authority, missing retry keys, spoofing, CSRF/origin, stale MFA and safe errors. PostgreSQL tests cover all five plan defaults and complimentary mode, employee/billing non-regression, append-only permissions, owner/HR reads, denied owner writes, cross-company scope, revocation, concurrent exact retry/stale races, disable/history retention, no-op rejection and invalid direct commands.

Recovery fixtures include an allocated company, a subsequently disabled company, three historical versions and an old request replayed after restore. Snapshot equality, current disabled state and observer retry receipts are verified separately. The independent recovery table whitelist includes allocation history.

During development, an incorrect platform audit column caused initial new allocation transactions to roll back. After correcting the unpublished migration, a guarded local-only script verified the new table was empty and the migration was the newest, removed only that new table/functions/history entry, and reapplied migration/bootstrap. Existing migrations/data were not reset. A test-only TypeScript delegate-union assertion was also corrected before successful final reruns. The temporary ignored repair script was removed.

No browser/provider/hardware tests are claimed for this backend-only increment; the device workspace and provider logic are unchanged. No remote CI, live biometric data, SDK permission, production rollout or production acceptance is inferred.

## Next

Add the operator allocation workspace and tenant-visible read-only allocation state, with version review and exact uncertain-command retry. Then implement single-use enrollment, reservations/device bindings and revocable machine credentials with atomic quota enforcement. Real K50/reset identity, SDK distribution, durable ingestion, shifts, leave and payroll gates remain pending. Apply migration and reviewed bootstrap permissions together; rollback disables these command routes while preserving allocation/audit/outbox history.
