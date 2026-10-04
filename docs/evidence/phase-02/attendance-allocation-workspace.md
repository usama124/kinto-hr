# Attendance allocation management workspace

Date: 4 October 2026. Starting main: `34f5631` (PR 63). Branch: `codex/attendance-allocation-workspace`.

## Implemented scope

The operator directory links to `/platform/companies/{tenantId}/attendance`. Operators review current allocation and its version, prepare a change, inspect a separate confirmation, and explicitly apply it. Enabling requires positive whole-number device/connector limits up to the existing technical bound of 1000. Initial setup, allocation changes and disabling use the existing fixed reason categories. Disable sends zero limits; no-op edits are refused locally. Editing invalidates the previous review.

The `/attendance-capacity` page, linked from draft device inventory, is read-only for company owners/HR. Refresh obtains the current selected company and roles again. Both views validate the strict snapshot and exact tenant reference, clear old data before refresh, and reject machine-access-enabled or wrong-company responses. Backend authority, active company/subscription checks and recent MFA remain authoritative. No company or employee self-registration is added.

Every save and exact retry obtains a fresh session/CSRF token. A synchronous in-flight guard blocks concurrent UI commands. An unconfirmed save retains its exact payload, expected version and UUID request key in component memory and blocks all new edits. Refresh can show newer state but cannot discard that pending request. Explicit exact retry uses the original payload/key, so an older receipt cannot restore a later disabled allocation. A confirmed receipt must have the expected successor version; current state is then read separately. A confirmed receipt followed by a read failure requires refresh, not another save. Stale/refused commands remove editing until refresh; revoked/signed-out access discards snapshot, review and pending state. No credentials, request keys or input values are persisted to browser storage.

The Next.js proxy now also forwards `/api/v1/platform/:path*` to the same trusted operator-configured `API_URL` used by other API routes. This repairs a missing forwarding rule affecting existing platform screens; it does not remove API authorization, origin/CSRF, rate-limit or MFA checks. A browser regression compares the actual forwarded unauthenticated response to the direct API response.

No database schema, API permission, subscription pricing, entitlement defaults, worker behavior or machine credentials change. All plans still default to disabled/zero. An allocation is capacity configuration only: machine access is always unavailable. Draft device inventory remains unconnected/unverified; no actual usage or hardware approval is implied by configured limits.

## Verification

Local checks passed:

- `pnpm verify`: formatting, lint, type checks, 214 unit/API tests across 30 files, coverage thresholds, 10 planning documents/178 local links and readiness-manifest integrity (`productionAccepted: false`).
- `pnpm build`: API, web and worker production builds passed; both new allocation routes are present.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: 116 desktop/mobile browser regressions passed, including 16 allocation runs. After final scoped styling changes, the application was rebuilt and all 16 allocation browser runs passed again.
- Synthetic desktop and 360px mobile screenshots were visually inspected after the final build. Ignored artifacts: `.local/attendance-allocation/desktop.png` and `mobile.png`.
- `git diff --check`: passed.

New browser journeys use synthetic intercepted API state with the actual built web app, except the unauthenticated proxy regression which reaches the real API. They cover review/apply/disable, exact retry after an uncertain commit and later disable, refreshed CSRF, stale conflicts, review invalidation, revoked session clearing, company read-only selection, employee denial and strict wrong-company/machine-access response rejection, malformed receipt reconciliation and confirmed-save/read-failure recovery. Desktop and 360px mobile overflow are checked.

The initial targeted run passed all 12 mocked desktop/mobile journeys but its two real-proxy assertions expected 401. Authentication-disabled mode intentionally returns 404 from the API. The regression now compares status and safe JSON fields against that API response instead of assuming enabled authentication. A subsequent run correctly exposed that two real requests have different correlation IDs; the assertion checks the proxied UUID/header independently and compares stable fields, preserving correlation semantics. The first sandboxed Next.js build could not parse its TypeScript subprocess output; the permitted build outside the sandbox passed. Neither failure required weakening authorization or changing business behavior.

No database integration, migration/restore, provider/Keycloak or K50 hardware checks are rerun for this UI/proxy-only increment. Historical backend evidence remains in [allocation controls](attendance-entitlement-controls.md). No remote CI, production acceptance or phase completion is claimed.

## Next and release boundary

Next: single-use local connector enrollment with atomic capacity reservations, tenant/device binding and revocable credentials. Enrollment and future usage must share the allocation lock and recheck fresh company/subscription/allocation state; reducing/disabling live capacity needs explicit usage semantics before any machine can activate. Real K50 model/firmware/reset-identity evidence, SDK rights, durable ingestion, shifts/leaves, payroll and foundation production review remain pending. P02-01 is still partial.
