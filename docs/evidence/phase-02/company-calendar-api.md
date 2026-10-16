# Company calendar persistence and date resolution — 15 October 2026

## Scope

Adds a company-wide `company_calendar` domain to existing company policy versions, private actor-scoped command receipts, owner draft/publication commands, owner/HR bounded history and authoritative read-only company-date resolution. Weekly rest remains defined by published attendance timing rules; calendar settings do not introduce a competing rest-day source.

Holiday dates and names are explicit employer input, with no assumed Pakistan public holidays or statutory entitlement defaults. `effectiveFrom` begins the reviewed coverage and `coverageUntil` is inclusive, with at most 366 calendar dates per version. An explicit empty holiday list declares no holidays within that coverage, not permission to infer workdays outside it. One holiday per date is supported, company-wide; branch/employee exceptions and partial-day holidays are not implemented.

This is usable configuration/read-only backend functionality, not a live leave/attendance calculator. Employee applicability, employment resolution, canonical leave balances, durable attendance/payroll period locks, reservation/decision persistence and employee workspaces remain pending. All attendance-processing, leave-reservation and payroll-effect availability flags remain false. No UI is added in this increment.

## HTTP boundary

Under `/api/v1/tenants/:tenantId/organization/policies/work-calendar`:

- `GET /`: bounded `limit`/`afterId` history with optional employer-local `asOf`, current policy and latest published version.
- `POST /drafts`: explicit effective date, coverage, holiday list, expected current published version and reason; UUID `Idempotency-Key` required.
- `POST /:policyId/publication`: confirmed draft version and reason; UUID key required.
- `GET /days?from=YYYY-MM-DD&until=YYYY-MM-DD`: inclusive, ordered, at most 366 employer-local workdates.

Every route derives identity, selected company and recent MFA from the server session. Writes also require exact Origin/CSRF. SQL requires current owner authority for writes and owner/HR for reads; employees/foreign company accounts cannot use these administrative routes. Owner authority is checked before retry receipt lookup, with membership revocation serialized against writes. Responses retain existing no-store/error boundaries.

## Lifecycle and persistence

Publications are prospective in Asia/Karachi, strictly later than every existing publication, and based on the current published version, including scheduled future versions. Competing old-base drafts become stale. There is no draft editing/deletion or retroactive holiday correction endpoint. Corrections affecting finalized periods require a separately designed workflow before operations are enabled.

Published history cannot be rewritten through runtime/control-role paths. A separate superuser fixture/restore exception matches existing policy history. Database constraints independently validate settings, exact keys, dates, coverage, duplicate holidays and names. A follow-up migration aligns command reason trimming and UTF-16 length limits with shared contracts without modifying an applied migration.

Company calendar commands share one company-specific advisory lock. Exact actor/company/key/canonical-input retries return the original ID/version without another policy, receipt, audit or outbox fact; changed payloads conflict. Policy/receipt/audit/outbox writes commit or roll back together. The observer acknowledges `company_calendar.create.v1` and `company_calendar.publish.v1` as configuration facts only.

`company_calendar_receipts` has forced RLS, no direct app/worker/dispatcher access, and only append/select grants for the non-login control owner. Application access is through constrained security-definer functions with fixed search paths. Schema-isolation and synthetic recovery inventories include the new table, bringing classified business tables to 57.

## Date resolution

The resolver reads complete published calendar and timing histories, independently for each requested date. It does not resolve from the displayed page, trust browser classifications or use a single current policy for the entire range. Holiday classification takes precedence over weekly rest; otherwise ISO weekday membership in the effective timing version gives rest or working day. Overnight work uses the scheduled check-in's employer-local workdate, not the checkout/receipt date.

Both calendar coverage and a published timing rule are required for a known classification. Missing/expired calendar coverage returns `CALENDAR_UNRESOLVED`; missing timing returns `TIMING_UNRESOLVED`. A newer expired calendar never revives an older, superseded calendar's longer coverage. Published history reports exclusive effective ends derived from the next publication and inclusive coverage end plus one. Current policy is null in uncovered gaps. Resolved rows retain calendar/timing policy IDs and versions; malformed or incomplete server responses are refused.

These company-date facts are not proof of employment, employee leave eligibility, approved leave, attendance completeness or an open/unlocked period. Future submission must resolve those independently and bind/recheck every relevant version under the same atomic reservation transaction. Policy publication concurrency and calendar corrections must share the future operational locking/reconciliation rules before live processing.

## Verification

Verification completed on 15 October 2026:

- `pnpm verify`: formatting, lint, types, all 521 unit tests with coverage thresholds, six launcher runtime checks, 250 local documentation links and readiness manifest passed. Production acceptance remains false.
- `pnpm test:integration`: all 291 SQL/HTTP checks passed, including 11 new calendar cases for history, coverage gaps, effective timing, permissions, concurrent exact retry, malformed direct SQL, immutable history, transactional rollback, fresh HTTP authority and idempotent outbox observation.
- `pnpm test:schema-isolation`: all 57 business tables passed classification.
- `pnpm test:migrations`: clean baseline, upgrade/backfill, all 62 migrations and replay passed.
- `pnpm test:recovery`: two-company synthetic restore preserved calendar history, exact create/publication receipts, date resolution and private table boundaries alongside existing snapshot assertions.
- `pnpm build`: all application builds passed; all four compiled worker runtime checks passed.
- The 95 contract tests passed under both `TZ=America/New_York` and `TZ=Pacific/Auckland`; whitespace checks passed.

An initial focused test run found a duplicated copied fixture declaration; it was removed before the passing final runs. Tests used isolated synthetic databases, preserving the existing demo company and local authentication configuration. Browser and real-provider flows were not rerun because this increment changes no UI or identity-provider behavior. No hardware or production acceptance is inferred.

## Next

Calendar review/configuration workspace, then authoritative employee employment/leave-policy applicability and durable attendance/payroll period-lock boundaries. Atomic request reservations, ledger/receipt/decision persistence and employee/manager flows follow those prerequisites. P02-03/P02-04 remain partial; hardware, production admission and payroll acceptance gates remain open.
