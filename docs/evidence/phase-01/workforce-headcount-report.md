# Workforce headcount report snapshot

Date: 25 September 2026
Scope: first P01-05 workforce reporting increment.

`GET /api/v1/tenants/{tenantId}/reports/headcount` accepts explicit ISO `asOf`, `periodStart` and `periodEnd` dates. The interval is ordered and bounded to 366 inclusive calendar days; missing or unknown query fields fail. The selected server session supplies tenant and actor identity. Access requires an active owner or HR administrator membership and trusted MFA within five minutes.

The security-definer database boundary derives headcount from active or ended employment periods that overlap the selected as-of date. It does not use the employee's current status, so historical terminated employees and future scheduled terminations remain accurate for their effective dates; planned draft periods are excluded. Joiners count qualifying employment-period starts and leavers count qualifying final working dates inside the requested interval. Rehire periods count as distinct workforce movements. Department counts use the latest assignment effective on the as-of date within the same employment period. A separate unassigned count exposes inconsistent historical data instead of silently assigning it.

The response contains only dates and aggregate counts. It excludes employee names, numbers, contact data, CNIC, compensation and other private fields. Department results include the tenant-scoped department ID, code and name. The runtime can invoke only the reviewed report RPC; internal authorization helpers and business tables remain unavailable directly, and forced RLS remains enabled on source tables.

Synthetic contract tests cover strict dates, reversed/excessive intervals and response projection. HTTP tests cover authentication, selected-tenant enforcement, recent/stale MFA propagation and unknown fields. PostgreSQL integration tests cover draft exclusion, historical termination, effective department grouping, as-of changes, second-tenant isolation, employee-role denial, stale-MFA denial and internal helper denial.

This increment does not create downloadable artifacts. The next report increment must add a formula-safe, permission-scoped CSV artifact with deterministic idempotency and audit creation/download evidence, then expose the aggregate report and export control in the responsive workspace. Production object storage/scanner work and full Phase 1 acceptance remain open.

## Local verification

- `pnpm verify`: passed; 21 unit/API files and 148 tests passed with 96.66% statement coverage, and all planning links validated.
- `pnpm build`: API, web and worker production builds passed.
- `pnpm test:integration`: 18 files and 145 PostgreSQL integration tests passed.
- `pnpm test:migrations`: clean foundation, all 37 migrations, restricted-role bootstrap, operator replay and second migration replay passed in an isolated generated database.
- Local `pnpm db:migrate` and `pnpm db:bootstrap`: the report migration applied and the exact RPC grant was verified against the synthetic `kinto_test` database.
