# Owner/HR draft device inventory workspace

Date: 4 October 2026. Starting main: `057bed1` (PR 61). Branch: `codex/attendance-device-workspace`.

## Implemented scope

The `/devices` screen and navigation entry expose the existing tenant-scoped inventory API. Owners can register drafts, edit metadata with an expected version, and confirm terminal retirement; HR can read inventory only. No authentication, schema, database function, permission or worker behavior is changed. Model/timezone are fixed to ZKTeco K50/Asia-Karachi; firmware is an optional unverified label, not compatibility evidence. Passwords, network profiles, template uploads, active device status and connector controls are absent.

Registration and metadata editing offer active company branches only. Codes are immutable during editing. Retirement sends the selected record's original metadata and version, not any unsaved form values, and remains available when its historical branch is inactive. Retired records keep their code/history and have no edit/reactivation controls. All records are labeled not connected, source identity unverified, no approved adapter and never synced. No real-time attendance badge or hardware approval is inferred.

Bounded pagination replaces the current page instead of accumulating an unlimited roster. Next cursors and ordered IDs are checked against returned pages; invalid response shapes/cursors produce an unavailable state and no displayed inventory. Refresh rechecks the session's current selected company, roles and CSRF, discarding previous company data/forms first. Initial reads abort on unmount. A local in-flight guard prevents concurrent UI commands; backend authorization remains authoritative.

Successful commands reload inventory. A stale/conflicting/missing record or uncertain write response clears the form and locks all further writes/pagination until a successful refresh. No automatic create/update retry is attempted because the command may already have committed. Denied/revoked or signed-out responses clear company data, inventory, branches, write controls and unsaved fields. Credentials/form values are held in component memory only, with no browser storage.

The screen reuses existing workspace styles with responsive form, wrapped metadata and mobile button layout. The build-progress screen now reflects locally tested foundation workflows and draft Phase 2 preparation while retaining production review gates. No new frontend dependencies are added.

## Verification

Final local checks passed:

- `pnpm verify`: formatting, lint, type checks, 209 unit/API tests across 29 files, coverage thresholds, 10 planning documents/172 local links and readiness-manifest integrity.
- `pnpm build`: API, web and worker builds passed. The generated roadmap includes updated Phase 1/2 statuses.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 100 desktop/mobile browser regressions passed, including 14 new device runs. Native invalid-code validation and invalid-firmware rejection before POST are included.
- Desktop and 360px mobile screenshots were visually inspected; the form and device records fit their viewport. Artifacts remain ignored under `test-results/device-workspace-{desktop,mobile}.png`.
- `git diff --check`: passed.

The first targeted browser run found an exact label locator that included dropdown option text; it was corrected to the accessible combobox role before both complete successful browser reruns. No unresolved failures remain. Foundation readiness still reports `productionAccepted: false`.

Seven new journeys extend the existing browser suite in desktop and 360px mobile projects: owner creation/editing/retirement and cancellation, HR read-only pagination, uncertain/conflicting write lock, revoked access clearing, signed-out/unselected/unauthorized contexts, invalid response/current-role refresh, and retirement on inactive branches with blocked draft registration. Browser mutation fixtures assert the CSRF header, immutable code exclusion, original retirement metadata and version. Tests check viewport overflow and empty local/session storage.

These browser journeys use synthetic intercepted APIs with the actual built web application. They do not replace the previous PostgreSQL authorization/concurrency/restore evidence. No database integration, migration, restore, worker runtime, provider/Keycloak or hardware verification is rerun for this frontend-only increment. No remote CI or production approval is claimed. Local screenshots/traces under ignored `test-results`/`playwright-report` are not published with source.

## Next and release boundary

P02-01 remains partial: implement versioned device/connector capability and capacity entitlements before single-use enrollment, revocable machine credentials, verified device binding, effective employee mappings and ingest authentication. Draft inventory must never be converted directly into trusted attendance preflight scope. Real K50/SDK/reset-identity evidence, local connector recovery, durable ingestion/acknowledgments, shifts, leave settlement and payroll remain pending. Foundation production gates remain open.
