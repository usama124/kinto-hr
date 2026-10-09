# Company timing contracts and pure preview — 10 October 2026

## Scope

Begin P02-03 with shared employer-configured timing schemas and a pure domain schedule preview. No policy is saved or published, no new HTTP route/UI is enabled, and no attendance, leave, absence, salary or payroll result is produced. Existing organization-defaults contracts/database domain restrictions remain unchanged and reject timing settings. The domain package now declares its internal contracts dependency; no external package/version changes were made.

## Policy constraints

All fields are explicit; no statutory or employer defaults are invented. Initial scope is company-wide, Pakistan's `Asia/Karachi` zone and fixed-duration unpaid breaks. Branch/employee overrides and explicit break-punch mode are rejected. Local check-in/out use exact `HH:mm`; the checkout-next-day flag must describe a positive shift shorter than 24 hours. ISO weekdays are Monday 1 through Sunday 7, unique, with at most six configured rest days; an empty list means none configured, not a legal recommendation.

Durations are integer minutes. Validate `0 < minimumHalfDay < minimumFullDay <= fullDayTarget`, `minimumHalfDay <= halfDayTarget < fullDayTarget` and `fullDayTarget <= netScheduledMinutes`. Breaks must be shorter than the shift. Grace values cannot exceed net scheduled time. Targets may be below net scheduled time; this does not discard worked minutes, approve overtime or establish a payable rule. Reject daily association windows wider than 1,440 minutes; touching half-open boundaries are permitted. This conservative daily bound also applies when weekly rest days create a longer gap.

The future draft-input contract requires an explicit expected current version, effective date, settings and reviewed reason. Its pure date parser does not claim to enforce current-day, cutoff, authorization, stale-version or finalized-period publication rules. Those checks belong in the future authoritative SQL command and must be repeated at publication time.

## Pure preview

`previewAttendanceTiming` validates unknown input before arithmetic. It returns scheduled/net minutes and a half-open association interval in local-minute offsets from the scheduled check-in date. Overnight checkout offsets can exceed 1,440; pre-check-in offsets can be negative. These are not normalized UTC punch instants. Rest-day presentation is sorted without mutating the input. Targets and qualification minimums remain separate; grace never increases net minutes. Attendance-processing and payroll-effects flags remain false.

The synthetic 22:00–06:00 shift with a fixed 30-minute break previews 480 scheduled and 450 net minutes. This is schedule arithmetic, not proof of 450 minutes actually worked. Actual punches, leave/calendar/employment segments, missing evidence and policy/period revisions remain future calculation inputs.

## Verification

- `pnpm verify`: formatting, lint, TypeScript, 370 unit/API tests in 38 files, 220 planning-document links and readiness-manifest validation passed. Configured coverage: 98.01% statements, 94.67% branches, 100% functions, 98.32% lines.
- Contract tests cover malformed times, ambiguous overnight/day-long shifts, break/net/target/minimum/grace boundaries, duplicate/invalid rest days, unsupported scope/break modes, numeric coercion/corruption and explicit draft inputs. A regression confirms the existing organization-defaults draft contract still refuses timing settings.
- Domain tests cover 450-minute overnight schedule arithmetic, negative previous-day association offsets, separate targets/minimums, grace not adding net minutes, invalid unknown input, deterministic previews across all 24 start hours and input/array non-mutation.
- `pnpm build`: API, web and worker artifacts built successfully.
- `pnpm test:worker:runtime`: all four compiled worker/monitor runtime tests passed, including startup/operational dependency behavior and graceful removal. This verifies the new internal package dependency is available in actual builds rather than inherited module lookup paths.
- No database, HTTP, UI or provider behavior was added: integration/migration/schema/recovery/browser/provider suites were not rerun for this pure-policy increment. Production acceptance remains false.

Fixtures are product examples, not Pakistan statutory policy or hardware evidence.

## Next

Implement owner-only, recent-MFA, tenant-scoped effective-dated timing policy persistence, preview and publication using the existing company policy infrastructure, with atomic audit/outbox, strict SQL validation and keyed retry reconciliation. Preserve immutable published history and prevent backdated/finalized-period changes. Then add the settings workspace. Actual event normalization and day qualification still require reviewed clock/source evidence and non-overlapping calendar/leave/employment segments; payroll deductions remain unavailable.
