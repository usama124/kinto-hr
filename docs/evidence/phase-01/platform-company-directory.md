# Platform company directory evidence

Updated: 1 October 2026
Scope: P01-02 read-only platform company and base commercial metadata directory.

## Implemented boundary

- `/platform` reads `/api/v1/platform/tenants` without a selected customer tenant. Each request independently checks the active platform operator and identity plus trusted MFA no older than five minutes. Customer membership/owner roles confer no platform authority.
- Migration `202610010002_platform_company_directory` adds a fixed-search-path security-definer function owned through bootstrap by the constrained control role. PUBLIC execution is revoked; the API receives only function execution, not new table grants.
- The projection contains company ID/name/status/creation date, owner provisioning state and current base subscription plan/version/classification/capacity. It excludes owner emails, identity/provider fields, employee records, compensation and payment information. Legacy missing provisioning/subscription records are explicit nulls.
- Strict query contracts bound pages to 1–100 rows (25 in the UI), validate UUID cursors and limit literal case-insensitive name search to 160 characters. SQL independently validates direct inputs. UUID keyset order avoids offset duplicates; one extra row determines the next cursor. This is a live directory rather than a frozen export snapshot.
- The responsive screen supports forward/back navigation, name filtering and refresh to page one. Filter changes reset cursor history. Failed/malformed responses fail closed, and denied access removes visible metadata. Requests use no-store and no browser persistence.
- Base capacity deliberately excludes temporary grants/overrides and active seat usage. Manual-paid classification is not payment evidence. Creation remains the separate platform company onboarding screen. No suspension, subscription change, invoice/payment action or HR data access is introduced.

## Verification

Existing contract/API tests cover bounded strict queries, unknown/private result fields, session-derived authority and missing-session denial. PostgreSQL cases cover two-company keyset pagination, literal percent search, base subscription/provisioning metadata, denied operator/MFA and direct NULL-limit refusal. Existing authorization tests cover revoked operators and disabled identities.

Desktop/mobile browser tests exercise list metadata, previous/next navigation, missing legacy setup, empty filters, filter reset, malformed results and removal after revoked access. Build, migration/bootstrap replay, integration and recovery checks use synthetic data only.

Production identity reconciliation, email, backup/PITR/file recovery, notification routing and approved staging/security remain open. Operator entitlement-management UI remains a separate foundation screen; pricing, invoices and collection remain Phase 4 work.

Checks passed on 1 October 2026:

- `pnpm verify`: formatting, lint, types, 161 unit/API tests and documentation links.
- `pnpm build`: API, web and worker production bundles.
- `pnpm test:integration`: all 153 tests.
- `pnpm test:migrations`: 43-migration upgrade/bootstrap/replay.
- `pnpm test:recovery`: synthetic database dump/restore; no PITR/file recovery claim.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 58 desktop/mobile tests.
