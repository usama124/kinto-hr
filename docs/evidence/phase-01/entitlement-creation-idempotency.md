# Entitlement creation idempotency and reconciliation

Implemented locally on 2 October 2026. This extends the [operator workspace](platform-entitlement-workspace.md), not production acceptance.

## Delivered boundary

Creation now requires a UUID `Idempotency-Key` on `POST /api/v1/platform/tenants/{tenantId}/entitlement-changes`. The database library also requires an explicit key. Migration 45 stores an immutable receipt scoped by company, authenticated operator and key. The database compares canonical typed input (type, epoch timestamps, capacity and audit reason). Exact replay returns the original creation ID and original versions without another control, audit or version increment. A changed request with the same key returns conflict. Different keys are distinct intentional requests; this does not deduplicate identical business input across different keys.

Receipt, control, both audit entries and aggregate version commit atomically under the existing company entitlement lock. Concurrent identical requests serialize. Refused requests do not reserve a receipt. Authorization is checked again on every attempt, including replays; active operator identity, recent MFA and active company are required. Replaying after revocation returns historical creation evidence and never reinstates the control. Current state still comes from history/effective-state reads.

The receipt table has forced row security and no runtime table privileges. Only the non-login control owner receives receipt read/insert rights through restricted bootstrap. The old non-idempotent creation function remains internal to that owner, with runtime execution revoked; the application can execute only the authorized idempotent wrapper. No employee records, provider identities or receipt collection endpoint are exposed.

The browser generates a key per preview approval and retains the exact approved request after an uncertain response. Other writes remain blocked; an explicit exact-retry button reconciles by executing the same command and returning its stored receipt, or creating it once if the previous attempt never committed. Repeated uncertainty retains the same key/input. Successful reconciliation shows historical receipt confirmation and refreshes current state. Definitive refusal clears the attempt and allows a corrected preview with a new key. Company route changes discard stale responses. Browser requests remain memory-only: page closure/reload loses the request, which the screen explicitly discloses. This is not a persistent browser queue or a cross-session request recovery facility. Uncertain revocations still require history review; revocation retry reconciliation is the next bounded hardening step.

## Verification

- `pnpm verify`: formatting, lint, types, 164 unit/API tests and documentation links.
- `pnpm test:integration`: 156 tests, including concurrent exact replay, one control/audit/version increment, changed-input conflict, same-key company isolation, failed-request reuse, all three control types, replay after revocation, revoked authority and direct-table/old-function denial.
- `pnpm test:migrations`: all 45 migrations, isolated clean baseline/upgrade/bootstrap/replay and tenant isolation.
- `pnpm test:recovery`: synthetic dump/restore verifies receipt equality and an exact retry after restore without changing any snapshot data. No PITR or file recovery claim.
- `pnpm build`: API, web and worker bundles.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: 62 desktop/mobile journeys; final receipt-message and route guards are rebuilt and checked in focused entitlement journeys.

Existing deployment/identity/provider reconciliation, staging/security review, notification delivery, backup/PITR/file recovery and retention approval gates remain open. No new subscription pricing, invoice, payroll or payment processing is added. Rollout must apply migration 45 and restricted bootstrap before deploying the new API/UI together; external callers must supply UUID keys. Receipts have no automatic purge pending approved retention rules.
