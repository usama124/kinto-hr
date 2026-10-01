# Membership access workspace evidence

Updated: 1 October 2026
Scope: P01-02 owner-only membership list, administrative role editing and revocation UI over existing audited APIs.

## Implemented boundary

- `/members` requires a selected company and owner role before loading the tenant membership API. The server independently checks current owner authority, selected session context and MFA no older than five minutes.
- Shared strict response contracts accept only membership/identity IDs, active/revoked state, tenant roles, positive versions, employee-link IDs and creation time. No email, provider subject, credentials or token projection is added.
- Only active administrative memberships expose editing. Employee-linked memberships and employee-role records direct the owner to employee lifecycle controls. Revoked memberships remain visible for audit history and cannot be restored here.
- Role replacement uses a canonical nonempty administrative role set, audit reason, expected version and the session CSRF token. Revocation uses the existing explicit POST command, a reason and confirmation. The browser cannot assign employee/platform authority or submit tenant/actor/status fields.
- PostgreSQL remains authoritative for employee-link protection, stale versions, no-op refusal and the final active owner. A conflict clears the draft and reloads current memberships without replaying the change.
- A failed or malformed mutation response may follow a committed change. Further edits are disabled until the user refreshes rather than allowing stale retries. Denied/expired access removes membership metadata and edit controls. All reads use no-store requests; no session or draft data is persisted in browser storage.

## Verification

Extended existing contract tests cover strict list/mutation responses, duplicate/unknown roles, malformed IDs/dates, private extra fields and invalid versions. Existing real PostgreSQL membership tests exercise tenant isolation, recent-MFA owner authority, employee-link protection, optimistic concurrency, revocation, audit evidence and concurrent final-owner preservation.

Desktop/mobile browser journeys cover role changes, confirmation dismissal/acceptance, revocation, protected employee rows, conflict refresh, uncertain-response edit blocking, loss of authority, empty/invalid projections and company/session/role gates. The production build includes `/members`.

This is a synthetic local implementation. Administrator invitation UI and tenant-safe administrator display names remain separate work; this screen deliberately shows opaque identity IDs. Production provider reconciliation, identity-disable synchronization, recovery, staging/security review and deployment approval remain open. No database migration or new runtime grant is introduced.

Checks passed on 1 October 2026:

- `pnpm verify`: formatting, lint, TypeScript, 159 unit/API tests and documentation links.
- `pnpm build`: production API, web and worker bundles.
- `pnpm test:integration tests/integration/membership-administration.test.ts`: all 6 tests.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 46 desktop/mobile tests.
