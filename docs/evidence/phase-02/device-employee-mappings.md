# Preparatory device employee mappings

Date: 5 October 2026. P02-01 remains partial; no hardware or production acceptance.

## Scope and authority

Owners with recent MFA can create or end a mapping through selected-company session routes with Origin, CSRF and UUID Idempotency-Key checks. Owners and HR with recent MFA can read bounded history and resolve a source ID at an explicit event instant. Employee/payroll roles, cross-company access and ordinary direct runtime table access are denied. HR remains read-only under the existing device-management permission model.

Routes under `/api/v1/tenants/:tenantId/devices/:deviceId/employee-mappings`:

- `GET /?limit=25&afterId=<uuid>`: bounded keyset history, including retired devices.
- `GET /resolve?sourceUserId=0007&at=<offset-timestamp>`: resolve from the complete history, not a displayed page.
- `POST /`: employeeId, sourceUserId, effectiveFrom, nullable effectiveUntil, reason `initial_mapping`.
- `POST /:mappingId/end`: expectedVersion, effectiveUntil, reason `end_mapping`.

Device user IDs remain exact, case-sensitive strings; `0007` and `7` differ. The provisional sanitized identifier envelope is ASCII letters/digits/underscore/hyphen, 1–64 characters. It is not a claim about verified K50 firmware formats. Offset timestamps are normalized to UTC with at most millisecond precision and bounds 2000 inclusive to 2100 exclusive. Effective windows are `[start,end)`; null end is unbounded. Adjacent assignments permit ID reuse without ambiguous boundary ownership. One ID may map differently on another device or company.

The server never guesses an employee. Resolution returns `mapped`, `unmapped` or `ambiguous`; unresolved results have null employee/mapping references. PostgreSQL exclusion constraints normally prevent ambiguity. Resolution is a preparatory administrative read, not attendance admission, employment qualification, exception processing or payroll calculation. No machine read permission is added.

## Persistence and replay

Migration 54 adds forced-RLS private mapping and append-only receipt tables with tenant-scoped device/employee foreign keys. The PostgreSQL `btree_gist` extension is required for a database-enforced non-overlap constraint. The shared inventory advisory lock also serializes creation against device retirement. New mappings require a draft device and non-archived employee; archived/retired historical relationships remain readable, and an existing assignment can be ended after retirement.

Ending only shortens an interval after its original start. It cannot change the source ID, employee, device or start, extend the interval, erase history or silently replace an assignment. Optimistic versions reject stale commands. Original command inputs and versions are retained in private receipts. An exact replay returns its original ID/version with `replayed: true`, even after subsequent edits; clients must refresh before another command. Reused keys with changed commands conflict. Permission checks occur before receipt replay. Lost responses require the same request key/payload and actor for reconciliation.

Mappings, receipts, audit and outbox commit atomically. Audit actions use resource IDs and fixed reason codes, not names/source IDs in logs. `device.mapping_changed.v1` is observed once; it does not recalculate attendance or rewrite payroll. No attendance events/locked periods exist yet: before enabling ingestion, changes must gain explicit unresolved-event reprocessing and locked/finalized-period safeguards. Mapping history preparation alone cannot satisfy that release gate.

## Verification

Focused contract/API suite: 50 tests passed. Existing attendance integration suite: 42 tests passed, including eight added mapping scenarios covering isolation, literal IDs, boundary reuse, concurrent overlap, exact retries, versioned ending, retirement/archive behavior, complete-history resolution, exclusion/FK constraints and transaction rollback.

The synthetic recovery drill now includes mapping rows/receipts in full snapshot equality, restored command retries, adjacent-window resolution and duplicate worker delivery. Aggregate verification passed: `pnpm verify` (270 unit/API tests, formatting, lint, root/web type checks, coverage thresholds and documentation checks); 237 integration tests; schema isolation for 49 business tables; all 54 migrations on a disposable database; and the extended recovery drill. Recovery evidence is private at `.local/recovery/d073896738734ef492bfa175d7fd4b38/report.json`. API, web and worker builds passed, as did four built-worker runtime tests. All 146 desktop/mobile browser regressions passed. Provider-specific Keycloak acceptance was not rerun because no provider flow changed. Production readiness remains unaccepted. No real K50 data is used.

## Remaining work

Next bounded increment: owner/HR mapping workspace. Device activation, verified SDK/source IDs, secure host storage, credential rotation, durable raw ingestion/deduplication, mapping exception/reprocessing workflows and production admission remain pending. P02-02 through later attendance/leave work is not completed by this API.
