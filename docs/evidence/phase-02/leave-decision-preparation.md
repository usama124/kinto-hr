# Leave decision and ledger-delta preparation — 15 October 2026

## Scope

`previewLeaveDecision` prepares P02-04 approval/rejection and pre-approval cancellation rules as an immutable pure function. Strict internal contracts describe an existing request's canonical allocation, the requested decision and independently resolved effective routing/period snapshots. This is not an HTTP command, authentication mechanism, reservation store or ledger writer. No employee request screen or submission endpoint is enabled. Reservation/payroll availability flags remain false.

The planner starts from pending requests only. Draft creation, initial submission/reservation, amendment, opening balances, accrual, carry-forward, approved reversal and absence settlement remain unimplemented. Existing company policy configuration and its UI are unchanged.

## Decisions and authority boundary

Approval/rejection follows the resolved eligible reporting manager; eligible HR may decide only when that manager is absent. Neither the employee nor the original submitter may approve/reject their own request, even if listed as manager or HR. Pending cancellation is available to the employee, original submitter or eligible HR, but not to a manager solely because they are the approver. This administrative cancellation rule needs product review before mounting. Ineligible callers receive a generic refusal before request version or terminal-state information.

All identities are account identity UUIDs, separate from employee UUIDs. This bounded snapshot requires a linked employee identity; HR-only records without an account need an explicit future resolution contract. Routing is effective at decision time and has a separate expected version. Changing request/routing versions requires a new reviewed snapshot. Exhausted request versions refuse further plans.

These input shapes do not establish permission. A future service must derive actor identity from the authenticated session, verify current company membership/role, resolve the employee link and effective reporting assignment, independently determine manager/HR eligibility and check MFA/CSRF where required. Browser-supplied routing, status, allocation, identities or open-period claims must never be forwarded as trusted facts. A self/ineligible manager must resolve to no eligible manager before applying HR fallback; malformed/ambiguous context is refused rather than guessed.

## Allocation and transitions

Approval converts reserved half units to consumed half units in every affected annual and calendar-month bucket; total reserved plus consumed remains unchanged. Rejection/cancellation releases the pending reservation without adding usage and releases cross-type date/half occupancy. Approval retains occupancy. Plans retain the request's historical policy reference and paid/unpaid treatment; approval does not reread a lower current quota to erase an already accepted reservation or apply an additional quota debit.

Grouping uses employer-local dates and the stored recurring leave-year start, including cross-month/year, custom starts and leap days. Quantities accumulate as exact integer half units. Nonchargeable dates create no quota movement, but still require complete period evidence. Unsupported boundary years, duplicate dates, invalid year starts, spans over 366 inclusive days and requests without chargeable dates are refused. Strict output validation checks paired annual/month totals, negative release units, matching consumption, versions, occupancy and disabled effects.

Rejected/cancelled requests cannot reopen or release again. Approved requests cannot be approved/rejected again. Approved cancellation explicitly requires a separately approved reversal workflow; it cannot restore quota directly. Locked dates withhold all deltas for every pending transition, including cancellation. Missing, unknown, duplicate, extra or mismatched period evidence never means open.

No current work-calendar or lock table is introduced. Declared lock evidence is only a planning input. Every affected attendance/payroll period must be resolved and locked in the future database transaction, including nonchargeable dates, with an explicit correction path for finalized periods.

## Persistence still required

A candidate is not a committed decision. Two callers can obtain candidates against the same request version; repeated planning is deterministic, not idempotent receipt replay. Before enabling operations, implement authoritative calendars/employment/eligibility, durable period locks and canonical reservation allocations. Then serialize employee occupancy, request/routing state and quota buckets, validate that all pending units exist, apply all deltas/state/occupancy atomically, and append immutable ledger, actor-bound receipt, audit and outbox facts in one transaction. Authority checks must precede receipt replay. Concurrent decision losers must reread or replay the stored exact receipt, never release/consume again. Amendment and approved reversal require their own atomic contracts.

No real concurrency, database lock, recovery or production approval acceptance is claimed by this slice. It does not enable attendance settlement, salary deductions, legal entitlement defaults or employee-specific quota overrides.

## Verification

Verification completed on 15 October 2026:

- `pnpm verify`: formatting, lint, types, all 514 unit tests with coverage thresholds, six development-launcher runtime checks, documentation links and readiness manifest passed. Production acceptance remains false.
- The domain suite's 144 checks passed under both `TZ=America/New_York` and `TZ=Pacific/Auckland`. The 22 added checks cover transitions, manager/HR routing, self-approval, releases, stale/terminal states, cross-period half units, unresolved/locked evidence, scope and malformed/bypass rejection.
- `pnpm build`: API, web and worker application builds passed.
- Whitespace validation passed. Fixtures are synthetic; no company balances or credentials were changed.

The first full verification attempt could not run existing local-listener tests in the restricted sandbox and was stopped. The run with local socket access passed. Database integration/migration/recovery, browser, compiled worker runtime and live-provider checks were not rerun: this increment changes no persistence, routes, UI, worker handlers or provider flows. Shared contracts/domain are exercised by unit coverage and all application builds.

## Next

Authoritative employment/calendar/leave-applicability snapshots and durable attendance/payroll lock gates, followed by atomic request reservation/ledger persistence, exact receipts and decision commands. Request/approval workspaces and absence settlement follow the protected backend. P02-04 remains partial; hardware/source/clock, production connector and payroll acceptance gates remain open.
