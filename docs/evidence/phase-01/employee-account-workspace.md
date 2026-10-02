# Employee account provisioning workspace

Implemented locally on 2 October 2026. This closes the employee-account UI gap found during the [foundation acceptance review](foundation-acceptance-gaps.md), building on [request authorization](employee-account-requests.md) and [verified activation](employee-account-activation.md). Production identity/email approval remains open.

## Delivered boundary

`/employees` now offers login setup within each draft/active employee record to company owners and HR administrators. Payroll-only and employee-only roles have no setup control. Records with active or revoked login access do not show a new invitation form; existing explicit reactivation remains a separate owner-authorized action. The form accepts only the employee email. The employee ID comes from the roster, company from the selected workspace, authority from the server session and role from the existing fixed Employee activation flow. No administrator-role selector or public signup is added.

The form sends normalized email with session CSRF and a generated UUID idempotency key to the existing account-invitation endpoint. Unknown, malformed or unavailable responses retain the original immutable request and freeze its email for explicit exact retries. Provider setup/delivery pending states retain that same request; pending activation distinguishes delivered setup from active login. Terminal failed/revoked results offer no repair or fresh request. Active request results require a roster refresh to review current access. Server-side terminal results now bypass provider delivery, preventing an already active/failed/revoked request from being relabeled pending by an unnecessary provider attempt.

A strict shared result schema validates the account request ID, supported status and replay flag at both database and API boundaries and in the browser. It includes no provider identity, email, token, password or role collection. Existing database authorization, exact binding, different-key employee serialization, invitation expiry, trusted-MFA activation, tenant isolation and audit behavior remain unchanged. No migration is added.

Retry state is memory-only. Closing/reloading the page, losing workspace access or removing the eligible employee record discards it; the screen directs the user to operator reconciliation before another unresolved request. Password setup/reset and MFA remain provider-managed. No identity is assumed active from `202` or from invitation delivery alone. Provider setup remains disabled by default.

## Verification coverage

New API tests cover normalized email and exact-key/session binding, no-store results, provider delivery progress, anonymous/CSRF/cross-company denial, invalid keys, role/identity mass assignment, stale MFA, malformed provider status and terminal-state delivery avoidance. Existing real PostgreSQL provisioning/activation and recovery tests are retained.

Desktop/mobile coverage exercises repeated lost-response/provider/delivery retries with identical keys and input, pending activation, activated roster refresh, definitive conflict/correction with a new key, malformed-result blocking, access loss, role/lifecycle exclusions and terminal failure/revocation handling. Browser checks caught and corrected a two-column layout that hid setup status and overlapped buttons; the final form uses a single-column settings card and wraps long receipt identifiers.

## Rollout and remaining gates

Deploy the API/web together with the shared contract update; the HTTP request shape and database schema are unchanged. Apply the existing reviewed bootstrap/migration sequence for a clean installation. No production provider, customer identity/data, email route, storage or hosting is configured by this increment. See the [acceptance-gap record](foundation-acceptance-gaps.md) for the next local test-classification step and remaining operational approvals.

## Checks passed on 2 October 2026

- `pnpm verify`: formatting, lint, types, 173 unit/API tests and contract coverage thresholds.
- `pnpm test:integration`: all 161 synthetic PostgreSQL/Redis tests.
- `pnpm build`: API, web and worker production bundles.
- `pnpm test:migrations`: existing 46-migration upgrade/bootstrap/replay and tenant isolation; no migration added.
- `pnpm test:recovery`: synthetic dump/restore including pending employee requests and active employee links. Private ignored report: `.local/recovery/e6abd4b255474b0a994b318f86cd5636/report.json`; no PITR/file recovery claim.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 84 final desktop/mobile journeys passed. The initial layout failure was corrected and 12 focused setup checks passed before this full rerun.
- `pnpm check:docs`: 143 local planning links validated.
- `pnpm test:keycloak`: all 10 real local Keycloak scenarios passed, including fixed employee activation, MFA, non-enumerating recovery, reset replay/expiry and disabled signup. Private ignored report: `.local/keycloak/run-uDEvAU/report.json`; no production provider/email approval is implied.
