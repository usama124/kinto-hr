# Audited workforce report exports

Date: 29 September 2026
Scope: P01-05 asynchronous, permission-scoped workforce headcount CSV artifacts.

`POST /api/v1/tenants/{tenantId}/exports` accepts only `workforce_headcount_csv`, the same bounded headcount dates, a reason and a UUID idempotency key. Same-key/same-content retries return the original artifact; changed reuse conflicts. An owner or HR administrator needs a selected active tenant, same-origin CSRF and trusted MFA within five minutes. Creation stores no CSV bytes: it commits a pending forced-RLS artifact, fixed request parameters, 24-hour expiry, audit event and outbox event atomically.

The existing durable worker recognizes only the reviewed export event in addition to committed lifecycle facts. It receives no direct business-table privileges. A security-definer generator requires matching transaction tenant context, calculates the aggregate report once and changes the pending artifact to ready. A ready snapshot is immutable on retries, so later organization or workforce changes cannot alter downloaded content. Missing artifacts produce sanitized `EXPORT_UNAVAILABLE` retry state and retain the existing five-attempt/dead-letter behavior.

`GET /exports/{id}` reauthorizes the current user for polling and reports pending, ready or computed expired state. `GET /exports/{id}/content` reauthorizes again, rejects pending/expired artifacts, records a download audit event and returns a no-store attachment. CSV is UTF-8 with BOM and CRLF rows. Dynamic cells use RFC quoting and prefix an apostrophe when optional leading whitespace is followed by `=`, `+`, `-` or `@`. The artifact contains aggregate summary and department rows only; employee identifiers and private/compensation data are absent.

Synthetic contract and HTTP tests cover strict kinds/fields, dates, idempotency header, CSRF, selected tenant, stale MFA propagation, attachment headers and formula-safe output. PostgreSQL/worker tests cover concurrent exact retry, changed reuse, one artifact/audit/outbox fact, pending refusal, single immutable generation, receipt replay, unavailable-artifact retry, employee/stale-MFA/cross-tenant denial, direct-table/helper denial, 24-hour expiry and creation/download audits. The recovery drill generates a ready artifact, inventories the new forced-RLS table and verifies exact snapshot restoration.

## Local verification

- `pnpm verify`: formatting, lint, type checks, 23 unit/API files with 156 tests and documentation-link validation passed.
- `pnpm build`: API, web and worker production builds passed.
- `pnpm test:integration`: 19 files and 149 tests passed, including immutable-snapshot and unavailable-artifact retry assertions.
- `pnpm test:migrations`: clean foundation, all 38 migrations, restricted-role bootstrap, operator replay and second migration replay passed in an isolated generated database.
- `pnpm test:worker:runtime`: all 4 built worker startup, failure and monitor lifecycle tests passed.
- `pnpm test:recovery`: synthetic archive checksum, restore equality, 39 forced-RLS tables, ready export preservation and durable worker replay passed.

The responsive client is now implemented in the [workforce report workspace](workforce-report-workspace.md). Production object transfer/scanning/download, deployed file recovery, staging and full Phase 1 acceptance remain open.
