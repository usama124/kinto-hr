# Operator entitlement workspace evidence

Updated: 1 October 2026
Scope: P01-03 responsive operator entitlement read, preview, creation and revocation workspace.

## Implemented boundary

- The company directory links active subscribed companies to `/platform/companies/{tenantId}/entitlements`. The new GET projection independently checks active operator/identity and recent MFA; no customer tenant selection or HR permission grants platform authority.
- Migration 44 exposes effective capacity/billing classification and the latest 100 grant/override records through a read-only constrained security-definer function. It uses the existing resolver, including aggregate active seats, and excludes employee records and creator/provider identities. Truncation is explicit; suspended or unsubscribed companies are unavailable.
- Supported changes remain capacity add-on, complimentary package and employee-limit override. Dates are explicit ISO timestamps with timezone. Preview evaluates at the proposed start, is not a reservation and is invalidated by any input change or history refresh. Apply submits the exact previewed input through existing recent-MFA and same-origin CSRF authorization.
- History displays scheduled/effective/expired/revoked status at the server evaluation time. Revocation requires confirmation, reason and the record's expected version. Refused/stale writes clear the preview and refresh history; revoked records retain their reason and version.
- Existing creation has no idempotency contract. Unknown, malformed or unavailable mutation responses therefore block further mutations without automatic retries. Refresh is still available for reconciliation but does not unlock writes. The page instructs the operator to reconcile before reloading/resubmitting, since another creation could duplicate a grant. This is not a durable reconciliation queue.
- The workspace makes no payment, invoice, renewal or payroll claims. Complimentary controls suppress billing classification without altering role permission; money collection remains Phase 4. No session/draft data is saved to browser storage.

## Verification

Existing contract/API tests cover strict projections, typed tenant IDs and session-derived read authority. Real PostgreSQL tests cover operator-only state, cross-company separation, effective capacity, retained revoked history and no creator-ID projection alongside existing override overlap, versioned revocation and audit tests.

Desktop/mobile journeys cover preview invalidation, exact-input creation, confirmed versioned revocation, denied-access removal, conflict refresh and uncertain-outcome write blocking. Production builds, full integration tests, migration/bootstrap replay and synthetic database restore verify the local boundary.

Production identity-disable synchronization, provider reconciliation, approved staging/security, notification delivery, backup/PITR/file recovery and retention/legal approval remain open. Persistent idempotency/reconciliation for entitlement creation is a follow-up hardening item; do not describe this screen as production accepted.

Checks passed on 1 October 2026:

- `pnpm verify`: formatting, lint, types, 163 unit/API tests and documentation links.
- `pnpm build`: production API, web and worker bundles.
- `pnpm test:integration`: all 154 tests.
- `pnpm test:migrations`: 44-migration upgrade/bootstrap/replay.
- `pnpm test:recovery`: synthetic database dump/restore; no PITR/file-storage recovery claim.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 62 desktop/mobile tests. The final scheduled/expired label adjustment was rebuilt and the four entitlement journeys rerun successfully with an explicit scheduled-label assertion.
