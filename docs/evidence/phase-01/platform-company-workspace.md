# Platform company onboarding workspace evidence

Updated: 1 October 2026
Scope: P01-02 platform operator company creation over the existing idempotent provisioning command.

## Implemented boundary

- `/platform/companies` first reads the session CSRF token and a minimal `/api/v1/platform/access` projection. No selected company or company membership is required. Tenant owners, employees and HR do not gain platform authority from their roles.
- Migration `202610010001_platform_access` adds a read-only, fixed-search-path security-definer function returning only whether the exact active identity is an active platform operator with verified MFA. PUBLIC execution is revoked; the constrained control role owns the function and only the API runtime receives execution through bootstrap. The HTTP adapter derives MFA recency from the server session, never browser fields.
- The creation form accepts company name, initial owner email, approved capacity (5/20/50/100/250) and free/complimentary/manual-paid classification. Free resets capacity to five. Shared contracts normalize email/name and reject unsupported fields. No pricing, invoice issue, payment confirmation or subscription collection is enabled.
- One memory-only UUID key and immutable request snapshot cover creation and provider retries. Uncertain/malformed responses keep fields locked and retry the exact command. Definitive validation/conflict refusal permits correction with a new key. Known company/request IDs cannot change on retry.
- The result distinguishes provider-pending, activation-pending, already-active and failed/revoked owner setup. Neither request acceptance nor provider delivery grants immediate owner permission. Password/email/MFA setup remains provider-managed; no company self-signup or browser-generated credentials are added.
- Denied/expired sessions remove the form/results. Strict access/result contracts reject unknown states and extra private fields. Reload/close loses the memory-only key, which is explicitly disclosed with instructions to reconcile unresolved requests before creating another company.

## Verification

Extended existing API tests cover session-derived platform checks, missing session and stale-MFA downgrade. Contract tests cover strict access/results. Real PostgreSQL tests cover ordinary/missing-MFA/revoked-operator/disabled-identity denial, NULL MFA, constrained function ownership and PUBLIC execution revocation, alongside existing creation concurrency, exact replay, cross-role denial and audit persistence.

Desktop/mobile browser tests cover provider-neutral platform access without selected tenant, normalized complimentary creation, exact-key retries, provider/activation status, conflict correction, malformed access/results, free-package reset and loss of session authority. Migration upgrade/replay and synthetic recovery checks verify compatibility.

All fixtures are synthetic. Production provider/email approval, reconciliation, recovery and deployment/security review remain open. Platform tenant listing/commercial overview is the next bounded screen; commercial billing itself remains Phase 4.

Checks passed on 1 October 2026:

- `pnpm verify`: formatting, lint, types, 160 unit/API tests and documentation links.
- `pnpm build`: production API, web and worker bundles.
- `pnpm test:integration`: all 152 tests, including 7 platform provisioning cases.
- `pnpm test:migrations`: 42-migration upgrade, bootstrap and replay.
- `pnpm test:recovery`: synthetic database dump/restore on the existing local cluster; no PITR or file-storage recovery claim.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 54 desktop/mobile tests.
