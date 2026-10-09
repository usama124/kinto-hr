# Synthetic inbox review workspace — 10 October 2026

## Scope

The `/attendance-review` owner/HR screen exposes the existing local-test read-only inbox routes. Navigation links to it from the workspace. It is a synthetic review screen, not live K50 attendance. The existing default-disabled connector gate, non-production configuration restrictions and server-side owner/HR/selected-company/recent-MFA permissions remain unchanged. There are no upload, approval, reprocessing, quarantine promotion or payroll commands.

## Read boundaries

Read a fresh selected-company session before listing devices and records. Fetch bounded UUID keyset pages (25 records) independently for devices and events; choosing another device or device page resets event pagination. Reject wrong tenant/device scope, duplicate/out-of-order IDs, oversized pages and inconsistent next cursors. Strict shared contracts reject unsupported biometric payload fields and any true source/clock/processing flag.

Recheck the current identity, company and eligible role after reads and before publishing results. Refresh, pagination and device changes erase old records and forms while loading. Denied, disabled, signed-out, malformed and failed reads clear the data, forms and preview. Requests use no-store; no raw events, preview times, session secrets or credentials are written to browser storage. In-flight operations are serialized and component unmount prevents later publication.

## Preview behavior

Choose a canonical event on the current page. Source IDs retain case and leading zeros; raw local times are explicitly labeled without verified UTC conversion. The operator must enter a hypothetical UTC/offset timestamp; it is never populated from the local punch or current time. Preview requests contain only that instant, and the server uses persisted source identity and complete mapping history.

Strictly validate the preview contract, exact normalized requested time and complete returned event against the selected canonical event. Mapped/unmapped/ambiguous results preserve unverified source/clock/attendance flags and quarantine. Editing either preview input clears the result. Owner and HR have identical read-only controls; retired history is readable, empty lists are explicit and no employee is guessed.

## Verification

- `pnpm verify`: formatting, lint, TypeScript, 324 unit/API tests in 38 files, documentation links and readiness manifest validation passed. Configured coverage remained 97.84% statements, 94.15% branches, 100% functions and 98.17% lines; web UI behavior is exercised in browser tests rather than this coverage metric.
- `pnpm build`: API, web (including `/attendance-review`) and worker artifacts built successfully.
- Focused desktop/mobile browser checks: 46 passed, covering owner/HR read-only access, explicit-time validation, unmapped/ambiguous outcomes, independent pagination, retired/empty history, strict list/preview corruption rejection, denial/outage clearing and company/identity/role changes during preview.
- Desktop and 360-pixel mobile screenshots were inspected; viewport checks passed without horizontal overflow. Only synthetic fixture data appears in screenshots.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 224 desktop/mobile browser regression checks passed, including the 46 new checks. The initial focused run exposed an exact-label test selector mismatch; the tests now select the dropdown by its accessible combobox role/name, and both focused and full reruns passed.
- No database, worker or provider changes: integration/migration/schema/recovery/provider/built-worker-runtime suites were not rerun for this UI slice. Production acceptance remains false.

Browser fixtures are synthetic HTTP responses; backend SQL authority was verified separately in the preceding HTTP slice. Browser fixtures do not prove physical-device compatibility or production login acceptance.

## Next

Begin P02-03 company-wide timing policy preparation: reviewed effective-dated check-in/out, overnight timing, break/grace and separate target/minimum full/half-day minutes. Do not turn uncertain punches into absence or payable attendance. Actual K50 source/reset/clock evidence, host credential protection, production admission/rotation, mapping reprocessing and finalized-period safety remain release gates. Leave accounting and payroll generation remain pending.
