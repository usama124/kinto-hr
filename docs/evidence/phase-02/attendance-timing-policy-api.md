# Versioned company timing policy API — 10 October 2026

## Scope

Adds authoritative timing drafts, owner publication, bounded owner/HR history and pure schedule previews. Reuses `company_policy_versions` under the separate `attendance_timing` domain; organization-default policy behavior remains separate. No employee-specific override, calculation, normalization, device ingestion, leave settlement, payroll effect or settings UI is enabled.

## HTTP

Under `/api/v1/tenants/:tenantId/organization/policies/attendance-timing`:

- `GET /`: bounded `limit` (25 default, 50 maximum), optional UUID `afterId` and ISO `asOf`. Current published policy is resolved from complete effective history, not the displayed page. The latest published version includes future schedules; no applicable policy returns null rather than guessed defaults.
- `GET /:policyId/preview`: draft or historical published settings plus pure local-minute schedule arithmetic. No automatic UTC punch conversion or attendance effect.
- `POST /drafts`: strict timing draft input and UUID `Idempotency-Key`.
- `POST /:policyId/publication`: expected policy version, reviewed reason and a distinct UUID `Idempotency-Key`.

Existing session cookie, selected company, address limits and recent server-derived MFA are required. Writes also require same-origin and session CSRF. SQL independently checks active identity, company and owner membership for writes; owner/HR may read. Bearer-only authentication and client identity/MFA overrides do not grant authority. Existing safe errors and no-store headers apply.

## SQL consistency and permissions

Migration 57 extends the policy domain/settings constraint with an independent SQL validator matching supported company timing bounds. A forced-RLS receipt table is private behind constrained functions, with no app/worker/dispatcher table access. Bootstrap assigns fixed-search-path SECURITY DEFINER functions to the non-login control owner, revokes PUBLIC access and grants only the necessary application entry points. Helper functions stay private.

Migration 58 corrects authorization locking without broadening tenant/identity UPDATE privileges: it retains the membership shared lock and existing fresh authorization predicate, plus the company/domain advisory lock for all draft/publication commands. Tests caught the original row-lock privilege requirement; both migrations replay together to the verified final definition.

Actor/company/key-scoped receipts compare exact parsed command semantics and return the original ID/version after uncertain responses, without repeating audit/outbox facts. Role/MFA/company/identity authority is checked before receipt lookup. Changed keys/payloads cannot recover another actor's receipt; changed payloads under the same key conflict. Policy, receipt, audit and outbox commit atomically. The worker only observes the two new committed fact types once; it gains no policy-table access and performs no attendance calculation.

Drafts require the latest published base version and a Karachi date no earlier than today and strictly after any already published effective date. Publications repeat those date/base checks; competing drafts based on an old publication become stale. Past drafts cannot be newly published. Exact already-committed retries remain readable after the original effective date. Published timing history is immutable to runtime/control paths; only explicit administrative superuser restore/fixture access is outside this application boundary. New versions append prospectively; no backdated rewrite or recalculation route exists.

There are no finalized attendance/payroll tables yet. This increment does not claim finalized-period recalculation safety is implemented: later calculators must retain the original policy version and reject locked-period reprocessing. Prospective-only policy publication avoids introducing a historical rewrite path now.

## Verification

Verification completed on 12 October 2026:

- `pnpm verify`: formatting, lint, types, 373 unit tests, coverage gates, 223 local documentation links and readiness manifest passed. The manifest remains `productionAccepted: false`.
- `pnpm test:integration`: all 273 tests passed, including real HTTP/SQL authority, concurrent publication, exact retries, rollback, immutable history and observer deduplication.
- `pnpm test:schema-isolation`: all 53 business tables classified and checked.
- `pnpm test:migrations`: all 58 migrations passed clean baseline, upgrade/backfill, replay and two-tenant delivery isolation.
- `pnpm test:recovery`: isolated synthetic backup/restore passed, including timing snapshots, exact draft/publication retries and private receipt access denial. The secured-table assertion was updated to include the new receipt table.
- `pnpm build` and `pnpm test:worker:runtime`: all application builds and four compiled worker runtime tests passed.

All fixtures use synthetic tenants and local PostgreSQL/Redis, not production accounts or a physical K50. Browser and live identity-provider tests were not rerun for this backend increment; no settings UI or provider flow changed. Recovery covers the local database, not file storage, PITR or a production restore.

## Next

Owner/HR timing settings workspace with explicit fields, preview/confirmation and exact uncertain-command reconciliation. Event normalization, daily classification, leave quotas/absence settlement and payroll generation remain pending, with source/clock, hardware, production operations and finalized-period gates unchanged.
