# Pure standard-workday qualification — 12 October 2026

## Scope

Adds strict internal day-preview contracts and `previewAttendanceDay`. Reuses published schedule association, source-preserving normalized candidates and effective device mapping snapshots. A shared `previewAttendanceScheduleWindow` now supplies the same IANA/transition-checked bounds to association and day calculations, including zero-punch days. No API, UI, database schema, raw inbox promotion or worker calculation handler changes. Attendance processing and payroll effects remain false.

Inputs are synthetic/trusted preparation, not authentication or proof. A caller declaring complete evidence, verified directions, employment/calendar/leave outcomes or an approved punch rule has not independently verified them. Future operational input assembly must resolve company-published rules, active effective schedules/mappings, complete closed device coverage and reviewed calendar/employment/leave facts. The punch mode is not an employee-specific override and is not yet persisted as an approved company rule.

## Standard working days

Only a known employed working day with no leave, a published effective schedule, complete closed evidence and an open period reaches qualification. Unknown employment/calendar/schedule, incomplete coverage, unverified normalization, unresolved/mismatched/out-of-interval mappings, unsupported offsets, outside-window or wrong-workdate punches remain unresolved. Scope mismatches, draft/future or duplicate schedules and forged UTC instants fail validation rather than calculate under another company/employee.

The verified in/out mode requires exactly two distinct, ordered punches with the expected directions. Missing, tied, reversed direction sequences or multiple-pair evidence is unresolved; fixed-duration break mode does not also infer explicit break pairs. Directionless evidence requires an explicitly approved first/last mode; that mode does not discard direction fields. Input order does not affect totals. Exact transport retries are deduplicated without using receipt time as identity; changed payload/mapping versions under one transport ID conflict. Repeated vendor event IDs under distinct transport IDs remain unresolved without independently verified reset epochs.

Actual gross duration is preserved separately. The fixed unpaid break is deducted once and capped at actual duration. Eligible time clips the span to scheduled bounds and applies the fixed break conservatively within that scheduled portion, capped at the clipped duration. Candidate overtime is actual net time outside eligible time; it is never used to fill minimum-hour thresholds and is never payable automatically. Explicit break-punch allocation and other break distribution rules remain unsupported.

Compare exact integer milliseconds against the separate full/half minimum thresholds, inclusively: full minimum gives `full_day` with zero candidate uncovered absence; half minimum gives `half_day` with 0.5; lower verified duration gives `insufficient` with one. These are reviewed policy candidates, not deductions or a legal statement. Full/half targets remain distinct from minima. Grace only affects late/early flags, with equality inside grace; it does not round timestamps or manufacture work. Millisecond totals are authoritative; displayed fractional minutes are derived without rounding.

A zero-punch absence candidate also requires an employee/device coverage mapping snapshot that spans the complete scheduled interval (including checkout), independently complete closed evidence and all working-day facts; incomplete or missing-punch evidence never defaults to absence. A historical unsupported-offset schedule is unresolved even when there are no punches. Response validation rejects contradictory qualification/absence units, null candidate policy references, inconsistent totals, duplicated references and inconsistent punch bounds.

## Exceptions and immutable references

Known holidays, rest days, non-employed dates and approved full-day leave produce exempt previews with no guessed work or absence units. Punches on those dates require review rather than automatic overtime or ignored records. Working-day calendar facts that conflict with the selected weekly rest policy require review. Partial/pending leave plus work stays `leave_composition_required`, with absence units withheld: a paid half-day leave must not accidentally become a second half-day absence. Segment composition and leave accounting remain next work.

Every qualification carries workdate, calculation version, policy ID/version, the supplied coverage mapping ID/version and the used transport/mapping references. Previewing a later policy does not mutate the previous result. A declared locked period returns unresolved before calculating work. This is not a durable lock implementation: no finalized-period table, operational input snapshot or enforced database recalculation lock exists yet, and future storage must implement those protections before live processing.

## Verification

Verification completed on 12 October 2026:

- `pnpm verify`: formatting, lint, types, all 432 unit tests, coverage thresholds, 232 local documentation links and readiness manifest passed. Production acceptance remains false.
- Focused domain suite: all 79 checks passed under both `TZ=America/New_York` and `TZ=Pacific/Auckland`; 30 new checks cover qualification, exceptions, evidence and contradictory response rejection.
- `pnpm build`: all application builds passed.
- `pnpm test:worker:runtime`: all four compiled worker runtime checks passed.
- Final evidence formatting, documentation-link and whitespace checks passed.

The focused run first caught a next-workdate fixture whose punch was later than receipt, correctly triggering normalization review. The fixture now supplies a later receipt; final runs passed. Review also added interval-spanning mapping coverage for zero-punch candidates, with unresolved/out-of-interval mapping tests.

All fixtures are synthetic; no real K50 logs, employer approvals or production company are involved. Database integration/migration/recovery, browser and live provider tests were not rerun: no schema, route, UI, provider flow or worker handler changed.

## Next

Pure partial-day leave/work composition, followed by trusted calendar/employment/leave input resolution and operational calculation snapshots/locks. Leave policy quotas, reservations/ledgers, absence settlement, payroll and physical/production connector gates remain pending. P02-03 is partial, not production accepted.
