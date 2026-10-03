# Tenant-scoped draft device inventory

Date: 4 October 2026. Starting main: `2663f5f` (PR 60). Branch: `codex/attendance-device-inventory`.

## Implemented scope

Preparatory P02-01 inventory API and persistence, not an activated attendance device registry. Migration 50 (`202610040001_attendance_device_inventory`) adds a forced-RLS `attendance_devices` table, bringing the classified business-table inventory to 44. Tenant/code uniqueness and the composite tenant/branch foreign key prevent cross-company assignments. Runtime application, worker and dispatcher roles have no direct table access. Reviewed fixed-search-path control functions are owned by the constrained control role; the application alone can execute inventory functions.

Recent-MFA owners create/update/retire records. Recent-MFA owners and HR read them. Membership, identity and company status are checked afresh in PostgreSQL; platform operators, employees and payroll roles alone gain no access. HTTP requests require an authenticated selected-company session; mutations additionally enforce origin and CSRF. Shared permission declarations match this owner/HR authority. No public signup or machine credential flow is added.

Routes:

- `GET /api/v1/tenants/{tenantId}/devices`: bounded UUID keyset pagination, default 25 and maximum 50 per page, with `afterId`/`nextCursor`.
- `POST /api/v1/tenants/{tenantId}/devices`: branch, unique immutable code, display name, `ZKTeco_K50` model, nullable firmware label, fixed `Asia/Karachi` timezone and `initial_setup` reason. Firmware metadata does not prove compatibility.
- `PUT /api/v1/tenants/{tenantId}/devices/{deviceId}`: full metadata and expected version, either `draft`/`metadata_correction` or `retired`/`retire_device`.

Only active same-company branches accept new/changed draft assignments. Retirement retains original metadata and may retain an inactive historical branch. Retired records cannot be reactivated, edited or removed through the API; their codes remain reserved. Simultaneous creates are serialized and simultaneous revisions produce one success and one stale rejection. Duplicate create conflicts and lost-update acknowledgments require inventory reload/version reconciliation; no automatic HTTP idempotency receipt is claimed.

Audit/outbox writes commit atomically with each successful change. They contain resource references, versions and fixed reason categories, not names, firmware, network addresses or credentials. Failed validation/authorization/conflicts produce neither writes nor partial events. The worker observes `device.inventory_changed.v1` with one durable consumer receipt and has no device-table access.

Every record is explicitly `not_connected` with null last sync, null approved adapter and `unverified` source identity. No active status exists. Passwords, local host/connection settings, templates/photos, caller tenant/actor/adapter approvals and arbitrary reason fields are excluded from mutation contracts. Draft inventory is not the trusted scope consumed by attendance preflight.

## Verification

Final local checks passed:

- `pnpm verify`: formatting, lint, type checks, 209 unit/API tests across 29 files, coverage thresholds, 10 planning documents/169 local links and readiness-manifest integrity.
- `pnpm test:integration`: 196 PostgreSQL/API integration tests across 20 files, including six new device-inventory scenarios.
- `pnpm test:schema-isolation`: all 44 business tables passed classification/RLS/privilege checks.
- `pnpm test:migrations`: clean baseline, all 50 upgrade migrations, replay/backfill and two-company delivery isolation passed.
- `pnpm test:recovery`: isolated synthetic restore passed with inventory and observer replay; private ignored report at `.local/recovery/f3eae8f0e0974bcc82a6e6b5635c2084/report.json`.
- `pnpm build`: API, web and worker builds passed.
- `pnpm test:worker:runtime`: all four built worker/runtime tests passed.
- `git diff --check`: passed.

The initial local migration attempt lacked the root test environment, so dependent setup/tests failed; the environment was loaded and migration plus complete role bootstrap succeeded before all successful reruns. No reset or deletion of customer data occurred. Foundation readiness remains `productionAccepted: false`.

Synthetic integration cases cover owner/HR authorization, missing MFA, revoked membership/disabled identity/suspended company, direct runtime/worker/dispatcher denials, cross-company branches, duplicate creation and stale-revision races, inactive branches, immutable retirement/code preservation, deterministic pagination and direct SQL invariant rejection. API tests cover selected tenant, credentials, CSRF/origin, strict inputs, server-derived actor and safe errors.

Recovery fixtures now include draft and retired devices in both synthetic companies. Snapshot equality and restored inventory reads verify metadata/status preservation. Replaying each of six restored inventory events twice produces one receipt per event. The independent recovery table whitelist and schema isolation regression reference include the new table.

No live device, customer data, SDK, remote CI approval or production deployment is used. Browser/provider tests are not rerun for this backend-only slice; no web interface or identity-provider behavior changed.

## Remaining scope and rollout

Next bounded slice: an owner/HR device inventory workspace. Before any activation/enrollment, implement versioned device/connector capacity and feature entitlements, single-use enrollment tokens, revocable/rotatable machine credentials, device binding, effective employee mappings and fresh machine authorization. No new commercial device limits are invented here; page bounds are query safety limits and draft records do not grant attendance capability. P02-01 acceptance is still partial.

Local connection profiles/secrets, verified adapter/reset epochs, heartbeat/last sync, durable ingestion/acknowledgments, K50 connector queue/restart/recovery and real hardware evidence remain pending. Timing, leave and payroll work remain pending. Foundation production review gates remain open. Apply migrations and bootstrap reviewed permissions together before exposing these inventory routes; rollback should disable the routes and retain records/audit/outbox rather than deleting history. This is not a public production release.
