# Company leave policy and quota planning — 12 October 2026

## Scope

Begins P02-04 with explicit company-wide leave policy/draft/published-snapshot contracts and `previewLeaveQuota`. Named paid/unpaid types have independent annual upfront request quotas, monthly usage caps, a reviewed leave-year start and inclusion/exclusion of non-working dates. There are no statutory defaults, employee quota overrides, monthly accrual, carry-forward or opening/accrual/adjustment ledger writes in this slice.

This is a pure reservation plan, not operational leave enforcement. No database/API/UI, request creation, approval, quota reservation or salary change is enabled. All reservation/payroll availability flags remain false. Declaring a policy published, a calendar resolved or a usage version current is not authority or proof; future services must derive those snapshots independently behind employee/HR permissions.

## Periods and date rules

Requests use employer-local dates taken, not submission time. Each date has a full/first-half/second-half part and trusted calendar/lock state. Workdays charge one or 0.5 day; reviewed policy may include holidays/rest days or exclude them. Unknown calendars, non-employed dates, declared locked dates and requests with no chargeable dates do not become reservations. Duplicate dates, malformed half quantities and spans longer than 366 inclusive calendar days are refused.

Split charged dates into every affected calendar month and leave year, including year/month boundaries, leap days and custom starts within a month. Leave-year starts must exist every year; February 29 starts are unsupported rather than guessed. One published effective policy interval is supported per preview; dates outside it require policy-window splitting. Changing the leave-year definition requires explicit reconciliation rather than resetting stored consumption. Future multi-policy submission must coordinate all windows atomically.

## Usage and quota

Authoritative snapshots carry company/employee/type, expected usage version, explicit annual/monthly reserved and consumed totals, and occupied date/half slots. Occupancy must include pending/approved leave across all types for that employee; quota totals remain type-specific. Full-day or same-half overlap blocks a new plan, while the opposite half may fit. Receipts, own-request amendments and approved reversal logic are not implemented; a caller cannot exclude its own allocation with an undeclared bypass field.

All affected usage buckets must exist. Missing, duplicate, corrupt period or over-physical-bound snapshots are unresolved, never assumed zero. A stale aggregate version requires rereading. Pending reservations plus approved usage reduce annual and monthly availability; approval must later convert reservation to consumption without another debit. Current quota reductions preserve stored usage and expose an over-limit amount rather than erase history.

Return `LEAVE_ANNUAL_QUOTA_EXCEEDED` or `LEAVE_MONTHLY_QUOTA_EXCEEDED` when the entire requested allocation does not fit, with only the scoped violating period/quantities. The plan is all-or-nothing: a later month failure exports no successful annual/month reservation. No monthly rollover, leave-type conversion or unpaid fallback is performed. Unpaid policy quotas constrain requests without claiming paid balance consumption or salary deduction.

Successful plans carry scoped request/policy references, expected usage version, explicit chargeable/excluded dates and each annual/month bucket's before/after availability. Half-day quantities are exact multiples of 0.5 and grouping accumulates integer half units. Snapshot counters remain unchanged. Response validation rejects contradictory totals, part quantities, duplicate request dates and availability arithmetic.

## Concurrency and operational gates

Two previews against the same snapshot can both fit; this is not a database race solution. Before mounting submission, implement authorization, effective company policy/calendar/employment resolution, canonical usage projection, deterministic employee/type/year/month locks and all-bucket atomic checks/reservations. Policy and usage versions must be rechecked inside that transaction. Exact command receipts must reconcile replay before duplicate reservation, and cancellation/amendments/reversals need immutable history and locked-period safeguards. No test here claims real concurrent reservations or ledger approval/release correctness.

## Verification

Verification completed on 12 October 2026:

- `pnpm verify`: formatting, lint, types, all 475 unit tests, coverage thresholds and readiness manifest passed. Production acceptance remains false.
- Focused domain suite: all 122 checks passed under both `TZ=America/New_York` and `TZ=Pacific/Auckland`; 20 new checks cover full/half monthly caps, annual exhaustion, reservations/consumption, boundaries, non-working dates, overlap, stale/missing data, reductions and bypass/corruption rejection.
- `pnpm build`: all application builds passed.
- `pnpm test:worker:runtime`: all four compiled worker runtime checks passed.
- Final formatting/link checks validate 238 local documentation links; whitespace checks passed.

The first focused run found an incorrect test-fixture request reference; it was corrected and final suites passed. All fixtures are synthetic; no employer legal approval, production leave account or payroll is involved. Database integration/migrations/recovery, browser and live provider checks were not rerun because no schema, route, UI, provider flow or worker handler changed.

## Next

Effective-dated leave policy/type persistence and owner/HR API boundaries, followed by atomic reservation/approval/release ledger behavior and workspace/self-service flows. P02-04 remains preparatory. P02-03 operational calculations/locks and physical/production connector gates remain open.
