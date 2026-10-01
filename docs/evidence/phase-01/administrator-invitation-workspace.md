# Administrator invitation workspace evidence

Updated: 1 October 2026
Scope: P01-02 owner-created administrator invitations in the existing `/members` workspace.

## Implemented boundary

- Only a selected-company owner can reach the form; the existing API independently requires recent verified MFA, selected tenant and same-origin CSRF. Owner, HR administrator and payroll preparer/approver are the only offered roles. Employees use employee-record provisioning; public signup is unchanged and excluded.
- The browser validates normalized email, canonical unique roles and a mandatory audit reason using the shared strict input contract. It generates one UUID idempotency key per new request and submits no tenant, actor, provider or activation state fields.
- Strict response parsing distinguishes provider setup pending, delivery pending, activation pending, already-active, failed and revoked requests. Recording a request or recording provider delivery is not immediate permission activation. Failed/revoked results never claim restored access.
- Lost responses, malformed successful responses and service failure retain the exact email/roles/reason/key snapshot in component memory. Inputs remain locked and retry reuses that snapshot. A provider- or delivery-pending result also exposes this same-request retry. Definitive validation/conflict refusal unlocks correction; a corrected submission receives a new key.
- Pending invitation state survives opening/cancelling a membership edit and refreshing the membership list. Invitation and membership mutations disable each other's controls while running. Denied or expired access removes the workspace. No session, email, request or key is persisted in browser storage.
- A page refresh/close loses the memory-only retry key; the UI explicitly directs operators to reconcile an unresolved request before a new submission. There is no invitation history/list, background resend queue, revocation or expiry renewal added by this UI.

## Verification

Existing contract tests now validate strict invitation results and reject unknown states, invalid IDs, nonboolean replay markers and private extra fields. Real PostgreSQL administrator-invitation regressions retain owner/tenant authority, exact-request replay, concurrency, provider binding and activation protection.

Desktop/mobile browser journeys cover normalized/canonical submission, exact-key retry after uncertain response and provider outage, pending activation, component state preservation, corrected conflicts, malformed replies, role restrictions and loss of authority. Existing membership browser tests continue to cover owner-only access and recent-verification denial.

All data is synthetic. Production provider reconciliation, email delivery, identity-disable synchronization, invitation history/recovery tooling and approved staging remain separate work. No migration or new runtime permission is introduced. Platform company provisioning UI is the next bounded foundation screen.

Checks passed on 1 October 2026:

- `pnpm verify`: formatting, lint, TypeScript, 159 unit/API tests and documentation links.
- `pnpm build`: production API, web and worker bundles.
- `pnpm test:integration tests/integration/administrator-invitations.test.ts`: all 7 tests.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 50 desktop/mobile tests, including provider/delivery-pending retries.
