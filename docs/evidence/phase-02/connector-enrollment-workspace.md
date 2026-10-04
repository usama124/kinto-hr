# Connector enrollment workspace — 4 October 2026

## Scope

Adds `/connectors` and workspace navigation for the existing protected synthetic owner/HR HTTP workflows. Owners issue 15-minute tokens for draft device/current allocation versions, inspect metadata and confirm token/credential revocation. HR receives read-only metadata with no issuance or revocation controls. HTTP/PostgreSQL checks remain authoritative; UI controls never grant permission or activation. Local mode remains disabled by default and production configuration remains rejected. A mode-disabled state is shown without retaining company data.

The page does not redeem tokens in the browser or expose machine credentials. There is no actual K50 connection, attendance ingestion, production machine access, installer, credential rotation or connector runtime choice. P02-01 remains partial. No SDK/runtime choice is made before the required hardware/SDK validation. The next bounded local work is connector client/service lifecycle preparation; actual device adapter, protected host credential storage and production admission review remain prerequisites for deployment.

## Safety and reconciliation

Every load/save/retry resolves a fresh selected-company session and identity. Pending commands also bind the original identity, because enrollment idempotency is actor-scoped; a different owner in the same company cannot submit the old attempt as a new issuance. Owner/HR roles gate the view; only current owners can submit writes. Current CSRF is obtained for each command rather than retained in the snapshot. Company or permission changes clear sensitive display and pending commands. Reads combine device inventory, enrollment metadata, credential metadata and current allocation, using strict shared contracts, tenant checks and independent bounded keyset pages. Each cursor must advance beyond the previous page, with sorted unique IDs and a valid last-row cursor. Failed reads remove stale snapshots/editable versions. Configured limits are explicitly not live usage totals; SQL enforces actual reservations/credential capacity.

Issued tokens are displayed once in a read-only input, held only in component memory. No secret enters URL, localStorage, sessionStorage, automatic clipboard operations or the credential list. Explicit hiding, refresh, expiry, document hiding and page lifecycle events erase the value. The input is also synchronously wiped on page hiding to avoid retaining a visible token in a page-cache snapshot. Navigation/unmount discards component state. A response arriving while the page is hidden does not reveal a token. Hiding never revokes a token; users must explicitly revoke it if it should no longer be usable.

Uncertain issue commands retain only the original identity/company, UUID key and immutable device/allocation payload in memory. New commands remain blocked across metadata refreshes; exact retry obtains fresh session/CSRF and must produce a metadata-only replay receipt. Wrong bindings, malformed replies, unexpected newly disclosed retry secrets and network/server errors leave the attempt unresolved and never reveal a secret. Rejected/stale commands require fresh versions before a new request. Successful issuance also requires refresh before another command, which intentionally hides the token.

Both revocation commands require explicit confirmation and fixed expected version 1. Unknown revocation responses retain the original identity/company/type/ID for an exact terminal retry, including after refreshed metadata already shows revoked. A redeemed enrollment directs the owner to its credential record; revoking the old token is not a substitute for credential revocation. Lost redemption responses are resolved by metadata inspection, credential revocation and new enrollment, never recovering/re-disclosing a credential. The screen explains that externally revoked credentials can remain active in stale restored SQL metadata without gaining admission.

Device selection only uses eligible drafts on the loaded page, conservatively excluding visible live reservations/credentials. This is a convenience, not a global usage calculation or compatibility claim. Branch/version/issuer/subscription/current allocation and capacity are still checked by the backend. Earlier unbound preparatory tokens remain non-redeemable by local HTTP clients.

## Verification

Recorded local checks:

- `pnpm verify`: formatting, lint/type checks, 239 unit/API tests across 34 files and coverage thresholds passed. Coverage: 97.72% statements, 94.04% branches, 100% functions, 98.06% lines; no frontend coverage percentage is inferred from these unit metrics.
- `pnpm test:integration`: all 229 tests across 20 files passed; existing real local HTTP/SQL/admission and tenant authority remain unchanged.
- `pnpm build`: API/web/worker builds passed, including `/connectors`.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 146 desktop/mobile browser tests passed, including 28 new workspace cases across both viewports. Same-company owner identity changes are denied before retrying actor-scoped issuance.
- `pnpm test:worker:runtime`: all four built worker/monitor startup/shutdown checks passed.
- Final source lint/format checks, 10 planning documents/190 links and `git diff --check` passed.

Browser fixtures exercise strict UI behavior; they do not replace the existing real SQL/Redis integration journey or prove actual device communication. Tests cover one-time display/non-storage, hiding/expiry, exact uncertain retries with fresh CSRF, confirmation/terminal revocation, HR read-only/disabled mode, role/company denial, strict response/cursor scope, stale versions, selected session and disabled allocation. Manual review identified actor-scoped idempotency as an additional retry boundary; attempts now bind the original identity and browser regressions prove that another owner cannot send them. The first targeted run found an ambiguous select-label test locator; it was changed to the accessible combobox role and the corrected targeted run passed.

No schema/grant/migration, OIDC/provider, admission-store lifecycle or hardware changes were made. Hardware/provider, remote CI, staging and production acceptance are not claimed. Foundation readiness remains `productionAccepted: false`.
