# Pure attendance normalization and schedule association — 12 October 2026

## Scope

Adds shared strict internal preview contracts and two pure domain functions: `previewAttendanceNormalization` and `previewAttendanceAssociation`. No API, UI, database table, connector admission, worker promotion or ingestion behavior changes. Existing synthetic inbox records remain quarantined. All outputs keep attendance processing and payroll effects disabled.

This is calculation preparation, not verified K50 compatibility. A caller constructing `sourceIdentity: verified` or `clock.status: verified` is not proof of either condition. Only future trusted registry/source/clock services may supply those inputs to a mounted workflow; upload payloads must never grant themselves verification.

## Normalization

The original parsed event is retained, including exact source user/event IDs, local timestamp precision, direction (or its absence) and work code. Server receipt time is kept separately and normalized to UTC. Source time is converted with a fixed +05:00 candidate and round-tripped through the actual `Asia/Karachi` IANA date. Historical dates with a different offset, or within the conservative 36-hour offset-transition probes, return `unsupported_timezone_offset`; they are not silently rewritten or accepted using the current offset. This bounded slice does not implement historical variable-offset/DST processing.

Explicit reviewed clock limits are required when supplying verified clock evidence. Absolute observed drift and permitted future lead use inclusive boundaries, with bounded nonnegative millisecond limits. Suspect drift, future timestamps or unverified source/clock evidence produce `needs_review` with no promoted UTC instant. No clock correction is applied. Delayed/offline events are not confused with drift solely because receipt is late; server time is not substituted for source time. Invalid dates, unsupported timestamp precision and malformed context fail strict parsing.

## Schedule association

The preview takes one to three explicit published schedule snapshots for the same tenant/device. It does not discover employee mappings, calendars, leave, employment state, the latest effective policy or locked periods. Future data access must resolve those facts independently.

Half-open association windows anchor to the scheduled check-in local date. Overnight checkout can associate to the preceding workdate; previous-day pre-shift offsets also work. UTC endpoints retain the source instant without rounding. Duplicate workdates, future-effective policies, draft policies and company/device mismatches are rejected. Altered UTC inconsistent with original source time is refused. Unsupported offset windows or multiple matching schedules remain `needs_review`; no punch is chosen for two schedules. A known window with no matching event returns `outside_window`, not absence or zero work.

A schedule candidate retains its policy ID, version, effective date, workdate and explicit UTC window. Later previewing with another policy does not mutate an earlier result. This is not persistence or finalized-period protection: calculation storage must capture used policy/mapping versions and prohibit locked-period reprocessing before any operational calculation is enabled.

## Verification

Verification completed on 12 October 2026:

- `pnpm verify`: formatting, lint, types, all 402 unit tests, coverage thresholds, 229 local documentation links and readiness manifest passed. Production acceptance remains false.
- Focused domain suite: 49 tests passed under both `TZ=America/New_York` and `TZ=Pacific/Auckland`, including the historical transition guard. The increment adds 29 tests to the existing domain suite.
- `pnpm build`: all application builds passed.
- `pnpm test:worker:runtime`: all four compiled worker runtime checks passed.
- Final documentation formatting/link and whitespace checks passed.

Tests use synthetic events and explicit independent UTC expectations. Database integration/migrations/recovery, browser and live provider tests were not rerun: no schema, HTTP, UI, provider flow or worker handler changed. No live device logs, employer rule approval or production service is involved.

## Next

Pure standard-workday qualification preparation: complete verified punches, worked/break minutes, distinct full/half-day targets and inclusive minimum thresholds, with missing/ambiguous evidence unresolved. Calendar, employment and approved leave composition must precede absence settlement. P02-03 remains partial; hardware/source/clock proof, trusted data resolution, production admission/rotation, durable calculations and finalized-period safeguards remain open.
