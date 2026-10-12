# Company timing settings workspace — 12 October 2026

## Scope

`/attendance-timing` exposes the existing versioned timing API. Owners create prospective company-wide drafts and publish reviewed proposals; HR can read bounded history and preview current, draft and historical published settings. Navigation links directly to the workspace. No employee-specific overrides, raw device uploads, attendance classification, leave settlement or payroll calculation are enabled.

The form requires explicit local check-in/out times, next-day checkout choice, fixed unpaid break minutes, full/half-day targets and separate qualifying minimums, grace, association offsets, weekly rest days, effective date and reason. Durations are integer minutes; no persisted policy is inferred from a sample schedule or prefilled timing default. Shared strict validation rejects impossible thresholds, shifts, breaks, duplicate rest days and overlapping association bounds. Confirmation is required separately for draft creation and publication.

## Display and authority

The page obtains the selected company, identity, owner/HR role and fresh CSRF from the server session. Authority is independently enforced by the existing API/SQL; displayed roles cannot authorize a command. Session context is checked before and after previews/commands and again before displaying loaded history. Context or access loss erases displayed history, forms, preview and pending command. Unmount aborts initial reads and suppresses later state publication.

Lists validate company scope, Karachi as-of date, strict effect-disabled flags, ordered IDs, bounded page size, advancing cursor and published version/date consistency. Current effective policy is resolved independently of pagination by the server. Previews must match the selected persisted snapshot and the schedule arithmetic; local offsets remain explicitly anchored to the check-in date, with an exclusive association-window end. Net scheduled minutes are not worked or payable minutes. Stale-base or expired proposals cannot be published through the form; SQL repeats the authoritative guards.

## Exact command reconciliation

Each confirmed draft or publication receives its own UUID idempotency key. A network/server failure or invalid receipt retains the exact immutable key, actor/company scope and parsed payload in memory. New writes are locked. Refresh reloads fresh history/authority and clears editable forms, while retaining an uncertain command only for the same owner and company. An exact retry uses fresh session CSRF without altering the command body or creating another key. Confirmed receipts and explicit validation/conflict responses require a history refresh before another command. Retry authority changes discard the attempt before any write.

The UI explicitly states that closing or reloading the browser tab loses the in-memory request. It does not persist policy payloads or CSRF in browser storage, offer unsafe abandonment of an uncertain write or infer success solely from refreshed list contents. No secret is involved or recoverable.

## Verification

Verification completed on 12 October 2026:

- `pnpm verify`: formatting, lint, types, all 373 unit tests, coverage thresholds, 226 local documentation links and the readiness manifest passed. Production acceptance remains false.
- `pnpm build`: all application builds passed, including the new `/attendance-timing` route.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 272 desktop/mobile browser checks passed, including 48 new timing checks. Coverage includes owner/HR display, explicit validation, canceled/accepted confirmation, draft and publication reconciliation, fresh CSRF, context changes, invalid snapshots/arithmetic, stale publication, pagination and access loss.
- The first full browser run caught an existing date-sensitive report selector: searching for headcount `12` also matched `2026-10-12`. That assertion now uses exact text; the complete rerun passed.
- Final formatting, documentation and whitespace checks passed.

Fixtures are synthetic and browser route fixtures exercise workspace behavior; the timing API/SQL has separate integration coverage. Database integration, migration, recovery, worker runtime and live identity-provider tests were not rerun for this UI-only increment. No production company, physical K50, production admission or payable attendance has been tested by this screen.

## Next

P02-03 remains partial. Next is verified-source event normalization and day-calculation preparation with pure synthetic tests, including overnight anchoring, missing/ambiguous punches, distinct target/minimum rules and immutable policy references. Hardware/source/clock proof, production connector admission/rotation, protected host credentials, leave accounting, payroll and finalized-period calculation/reprocessing gates remain open. Unverified synthetic inbox events must remain quarantined.
