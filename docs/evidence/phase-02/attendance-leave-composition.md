# Pure half-day leave and work composition — 12 October 2026

## Scope

Adds strict internal plan/approval/response contracts and `previewAttendanceLeaveComposition`. Composes one approved leave half with one scheduled work half while keeping work, paid leave, unpaid leave and uncovered absence units separate. No HTTP/UI/schema/worker-handler change, leave approval, quota reservation, ledger debit, absence settlement or payroll generation is enabled. All processing/payroll flags remain false.

Inputs are synthetic/trusted preparation. A typed `approved` status is not proof of HR authority, an available quota or an approved company partition. Future operational assembly must independently resolve those facts and persist company-wide half-day/break configuration; this function does not introduce employee-specific overrides or let upload payloads authorize leave.

## Explicit bounded plan

Require exactly two positive minute-aligned half intervals covering the published full schedule without gaps or overlaps, with one work half and one leave half. Each half's net planned duration must equal the company half-day target. This deliberately supports balanced net halves only: custom partial schedules, different target/schedule relationships and full-day leave composition require separate reviewed support and remain unresolved here.

Break positions are explicit, not guessed from fixed break duration. Zero to two intervals must lie inside the schedule, not overlap and total exactly the published fixed unpaid-break minutes. Breaks may cross the half boundary; their overlap is allocated precisely to each half. Break snapshots are returned in canonical order. Invalid intervals, excess timestamp precision and malformed records fail parsing; unsupported partitions withhold all absence units.

The approved leave snapshot is bound to company, employee and check-in workdate, retaining approval ID/version and paid/unpaid classification. This workdate remains the shift's start date even when the leave interval itself is after midnight. Missing, pending, rejected or cancelled approvals remain unresolved. Foreign approval scope is rejected.

## Evidence and accounting

Reuse the standard-day evaluator's source/mapping, scope, schedule, duplicate, punch-rule, closed-evidence and declared-lock guards. It is called with leave neutralized solely to validate evidence; its full-day fixed-break, qualification and absence totals are not exported or added to composition. The existing standalone day evaluator still withholds partial-leave outcomes. Zero-punch composition conservatively retains its full scheduled-interval mapping-coverage requirement.

Recompute actual gross duration and subtract only the explicit unpaid-break overlap with the punch span. Clip eligible work to the work half and subtract only break overlap in that intersection. Use the unchanged company half-day minimum inclusively in integer milliseconds; no proportional threshold or double full-day break deduction is invented. Late/early flags use the work-half boundaries and existing grace, without altering actual work. Actual time outside the work window is a non-payable overtime candidate and cannot satisfy a minimum.

Any positive overlap of the punch span with approved leave requires review, including one millisecond at a shared boundary; it is not silently charged as absence or counted twice. Missing/ambiguous/unverified evidence, unknown day facts, off-days or declared locks withhold composition. Neither a holiday nor a missing punch defaults to a chargeable work half.

Approved half-day paid leave plus a qualifying half-day work gives work 0.5, paid leave 0.5 and uncovered absence 0. Approved unpaid leave gives unpaid leave 0.5 and uncovered absence 0 when the work half qualifies: unpaid leave is not also absence. Insufficient or independently verified zero-punch work creates only a 0.5 uncovered work-half candidate while retaining the approved leave half. Pending approvals never produce a numerical absence result. No salary or leave-balance change follows these candidate units.

Responses retain timing-policy, approval and mapping/punch references plus used interval/break snapshots. Validation rejects contradictory unit totals, missing candidate references, inconsistent work totals/evidence and fabricated zero-punch lateness. Later previews do not mutate earlier results. Declared locks are refused, but durable database period locks, operational input snapshots, reconciliation and recalculation versioning remain unimplemented release gates.

## Verification

Verification completed on 12 October 2026:

- `pnpm verify`: formatting, lint, types, all 455 unit tests, coverage thresholds, 235 local documentation links and readiness manifest passed. Production acceptance remains false.
- Focused domain suite: all 102 checks passed under both `TZ=America/New_York` and `TZ=Pacific/Auckland`. This increment adds 23 checks covering paid/unpaid half leave, exact half minima, break placement, zero-punch coverage, retries, approval/context gates, overlap/partition errors and contradictory responses.
- `pnpm build`: all application builds passed.
- `pnpm test:worker:runtime`: all four compiled worker runtime checks passed.
- Final evidence formatting, documentation-link and whitespace checks passed.

All cases use synthetic fixtures and independently expected durations/units; no employer approval, production customer or real K50 logs are involved. Database integration/migrations/recovery, browser and live provider checks were not rerun: no schema, route, UI, provider flow or worker handler changed.

## Next

P02-04 leave-policy/quota preparation: company-wide annual entitlements, monthly hard caps and reviewed paid/unpaid classifications, followed by effective policy/approval persistence and atomic reservations/ledger accounting. P02-03 operational input resolution, durable attendance calculations, stored locks and physical/production connector gates remain open. Neither phase is production accepted.
