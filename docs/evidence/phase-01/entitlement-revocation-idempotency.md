# Entitlement revocation idempotency and reconciliation

Implemented locally on 2 October 2026. This extends [creation receipts](entitlement-creation-idempotency.md) and the [operator workspace](platform-entitlement-workspace.md), not production acceptance.

## Delivered boundary

Revocation now requires a UUID `Idempotency-Key` on `POST /api/v1/platform/tenants/{tenantId}/entitlement-changes/{kind}/{changeId}/revocation`. The database library also requires an explicit key. Migration 46 stores an immutable receipt scoped by company, authenticated operator and request key. Exact retries preserve target kind/ID, expected version and normalized reason. Reusing the key with changed input returns conflict. Replays return the original revoked record version and original aggregate version, never a claim that current commercial state is unchanged. New-key attempts against already revoked records still fail optimistic version checks.

The receipt, revoked record, aggregate version and both audit events commit atomically under the existing company entitlement lock. Concurrent exact retries produce one revocation and one audit pair. Audit failure rolls the entire mutation back. Refused/stale/not-found attempts do not reserve keys. Each replay rechecks active identity/operator authority and recent MFA; inactive companies are unavailable. Different operators cannot retrieve another operator's receipt through key reuse, and identical keys in different companies remain independent.

The new receipt table has forced row security and no application table privileges. Bootstrap grants only read/insert to the non-login control owner and constrained wrapper execution to the runtime role, removing runtime execution of the former non-idempotent revocation function. No receipt enumeration, employee detail, provider identity or payment processing is exposed. Receipts have no automatic purge pending approved retention rules.

## Operator workflow

The original revocation still requires confirmation and a reason. The browser saves its exact target, expected version, reason and UUID key in memory. Unknown, malformed or unavailable responses block other mutations and expose an explicit exact-retry button; retries do not repeat confirmation or replace the saved version after history refresh. The button remains available when refreshed history already shows the control as revoked, and when history refresh fails (the unavailable company metadata is removed). Successful reconciliation confirms historical receipt evidence and loads current history. Definitive conflict clears the retained attempt and refreshes state; access loss removes state and the retained request. Saved attempts are bound to their company and stale route responses are ignored.

Browser state is not persistent: closing/reloading the page loses the saved request, which the uncertainty notice discloses. Creation retry behavior remains supported, including the same failed-history recovery boundary. No cross-session recovery queue is added.

## Verification coverage

API tests require typed UUID keys, strict request fields, session-derived authority, same-origin CSRF and expected versions. Real database tests exercise all three commercial control types, four concurrent exact revocation retries, changed reason/version/kind/target rejection, company and operator separation, stale fresh-key attempts, replay after later controls, authority loss, suspended companies, audit-failure rollback and direct-table/internal-function denial.

Desktop/mobile journeys exercise initial confirmation cancellation, repeated uncertainty with unchanged key/body/path, retained version after revoked history, failed history refresh recovery, successful receipt confirmation, definitive conflict and lost authority. The synthetic recovery drill verifies receipt snapshot equality and exact creation/revocation retries after restore without additional state or audit changes.

## Rollout and remaining work

Apply migration 46 and restricted bootstrap before deploying the API and web together. External callers must supply UUID revocation keys; old direct runtime commands are intentionally unavailable. Existing operational gates remain: provider reconciliation and identity-disable synchronization, approved staging/security review, notification delivery, deployed backup/PITR/file recovery, retention approval and remote CI evidence. Foundation acceptance gap review is next; this increment does not declare the foundation production accepted or resolve K50/payroll external evidence.

## Checks passed on 2 October 2026

- `pnpm verify`: formatting, lint, types, 165 unit/API tests and 137 local planning links.
- `pnpm test:integration`: 161 tests across 19 files.
- `pnpm build`: production API, web and worker bundles.
- `pnpm test:migrations`: 46-migration isolated upgrade/bootstrap/replay and tenant isolation.
- `pnpm test:recovery`: synthetic database dump/restore, including unchanged snapshots after exact creation and revocation receipt retries. Private report: `.local/recovery/87dd5a91e1254a4ebb024f6f63606719/report.json` (ignored, not published).
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 68 desktop/mobile journeys against the final rebuilt UI.

No remote CI, real device, live payroll, file-storage recovery or PITR result is claimed by these local checks.
