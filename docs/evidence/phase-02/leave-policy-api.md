# Company-wide leave type and policy persistence

12 October 2026 · Synthetic/local backend verification only.

## Delivered boundary

Adds effective-dated company-wide paid/unpaid leave policies with explicit annual upfront quotas, independent monthly hard usage caps, half-day increments, leave-year start and reviewed non-working-day treatment. No statutory quotas are seeded. Stable leave-type codes are unique within a company; each policy version has its own display name and immutable settings.

Creating a type atomically creates its first draft. Owners create and publish; owners/HR read bounded type lists and draft/published history. No applicable published policy returns null, never guessed settings. Current policy and its exclusive end date are resolved from complete published history, independently of the displayed page. The latest published version includes future publications.

This does **not** submit/approve leave, reserve balances, create ledger entries, apply absence fallback, recalculate attendance or deduct salary. Responses explicitly report reservation/payroll effects unavailable. Monthly caps are policy configuration here; live over-limit rejection requires the later atomic reservation workflow.

## HTTP

Routes under `/api/v1/tenants/:tenantId/organization/leave-types`:

- `GET /`: bounded `limit` and UUID `afterId`.
- `POST /`: strict policy draft input with `expectedCurrentVersion: 0`, effective date, explicit settings, review reason and UUID `Idempotency-Key`; returns both type and initial draft references.
- `GET /:typeId/policies`: bounded history with optional `asOf` date. Drafts are visible but never counted as current policy.
- `POST /:typeId/policies/drafts`: expected latest published version, prospective effective date, explicit settings, reason and UUID retry key.
- `POST /:typeId/policies/:policyId/publication`: expected draft version, reason and distinct UUID retry key.

All routes use selected-company server sessions and recent trusted MFA. Writes additionally require exact Origin and session CSRF. Client identity/roles/company overrides, malformed keys, unknown query fields and year-zero persistence dates are rejected. Static leave-type creation is registered before the existing generic catalog POST; regression tests cover both boundaries. The API retains safe errors and no-store headers.

## Persistence and consistency

Migrations 59–60 add three private forced-RLS tables: `leave_types`, `leave_policy_versions` and `leave_policy_receipts`. Composite tenant/type foreign keys prevent cross-company references. Independent SQL validation enforces exact supported settings, integer/half-day bounds, valid recurring leave-year dates and shared name trimming semantics. No app/worker/dispatcher receives direct table access.

Fixed-search-path SECURITY DEFINER entry points use the existing owner/HR organization authorization predicate. Bootstrap grants the non-login control owner only required table/function privileges and keeps validators/JSON/trigger helpers inaccessible to application callers. Runtime history is immutable: drafts can only transition to publication, and published rows cannot be edited/deleted. Explicit administrative superuser restore/fixture work remains outside the runtime boundary.

Company-level advisory serialization protects actor/company/key receipts across all leave types. Authority is checked before replay; exact parsed semantics return the original type/draft/version without repeating audit/outbox facts. Changed payloads conflict. Type, policy, receipt, audit and outbox commit together; an audit failure rolls everything back.

Publication is prospective, based on the latest published version, and strictly later than prior effective dates. Competing old-base drafts become stale. Already-committed exact retries remain readable after the original date. Type codes cannot change; leave-year changes after publication are refused until an explicit reconciliation workflow exists. Lower quotas and paid/unpaid changes may be prospectively versioned, but future reservations must account for existing usage and pinned policy references; no operational balance reconciliation is claimed here.

The worker acknowledges the three new committed fact types once and receives no leave-table permissions. It performs no balance, attendance or pay calculation. Future attendance/leave/payroll period locks remain separate release gates.

## Verification

Completed locally on 12 October 2026:

- `pnpm verify`: formatting, lint, types, 492 unit tests with coverage, six development-launcher tests, 241 planning links and readiness-manifest integrity passed. Production acceptance remains false.
- `pnpm test:integration`: all 280 tests passed using a separate synthetic database, including real SQL/HTTP permissions, exact retries, publication races, stale/backdated commands, raw-SQL settings validation, immutable history, cross-tenant foreign keys and atomic rollback. Existing organization and employee/session boundaries remained covered.
- `pnpm test:schema-isolation`: all 56 business tables classified with expected forced RLS and restricted grants.
- `pnpm test:migrations`: all 60 migrations passed clean baseline, upgrade/backfill, replay and two-tenant delivery isolation.
- `pnpm test:recovery`: isolated synthetic backup/restore passed, including two companies' published leave settings, exact create/publication receipts, private-table denial and unchanged restored snapshots.
- `pnpm build`: API, web and worker builds passed. `pnpm test:worker:runtime`: all four compiled runtime checks passed in the isolated database.

Initial local checks found a migration syntax error, a generic-catalog route collision, incorrect superuser test simulation and an outdated restore table count; each was corrected before successful reruns. Shared demo-database dead-delivery alerts also invalidated empty-database worker-monitor expectations. The final full integration and compiled-worker runs used an isolated database; existing demo jobs were not deleted to make tests pass. No tests were skipped in the successful final runs.

The local development database received migrations and restricted bootstrap. Private reports remain under ignored `.local/`. Browser and disposable Keycloak verification were not rerun for this backend-only increment; no leave settings UI or provider changes are included. The complete `verify:full` release sequence was not run. Synthetic SQL restore is not production PITR, private-file recovery or live K50/payroll acceptance.

## Next

Owner/HR policy settings workspace with explicit inputs, history, confirmation and uncertain-command reconciliation. Then atomic request reservations/ledger, approvals, employment/calendar resolution, absence settlement and finalized-period safeguards. K50 proof, production operations, privacy and payroll approvals remain open.
