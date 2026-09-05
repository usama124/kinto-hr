# Customer security-audit evidence

Date: 6 September 2026. Scope: bounded P01-02 read-only tenant security-audit access using synthetic local identities, companies and events. This is not production security-log, retention or provider approval.

## Delivered boundary

- `GET /api/v1/tenants/{tenantId}/security-audit` requires an authenticated server session, an exact selected-company/path match, an active owner membership and trusted MFA no older than five minutes. HR, payroll and employee roles receive no audit-feed authority.
- A fixed-search-path `SECURITY DEFINER` function rechecks the active identity, membership, role and company on every call. It is owned by the constrained NOLOGIN, non-superuser, non-BYPASSRLS control role; the runtime receives execute permission but no direct cross-tenant audit read path.
- Results expose only event ID, actor ID, action, optional reason, resource ID and timestamp. Platform-operator audit events stay in their separate table and are never returned through this function or screen.
- Listing is newest first with a default page of 50 and hard maximum of 100. Exact action and inclusive ISO timestamp filters are strict. The opaque cursor contains only the prior event UUID, is resolved inside the requested tenant and uses `(created_at, id)` keyset order; a missing or other-tenant anchor returns not found.
- Tenant/action/time indexes support the permitted query shapes. Runtime roles retain no update/delete grant on audit records, so this view does not weaken append-only application behavior.
- The responsive customer screen obtains its company only from the server session, validates the response projection, supports exact-action filtering and duplicate-free “load more” pagination, and explains its owner/recent-MFA requirement.

## Verification

- `pnpm verify` passed formatting, lint, TypeScript, documentation-link validation and 92 unit/API tests with 100% measured selected coverage.
- `pnpm test:integration` passed 101 PostgreSQL/Redis/OIDC tests. The four new database cases prove safe newest-first projection, duplicate-free pages, exact action/inclusive time filtering, owner/recent-MFA enforcement, cross-tenant path/cursor denial, runtime immutability, null-limit fail-closed behavior and constrained function ownership.
- `pnpm test:migrations` applied all thirteen migrations from clean and previous schemas, bootstrapped restricted roles and replayed with no pending migration. `pnpm test:recovery` restored the thirteen-migration synthetic database in 739 ms; its ignored local report is `.local/recovery/bb04319738564445981a4aa9cd66b528/report.json`.
- API, web and worker production builds passed. All four standalone worker/monitor checks and all 16 desktop/mobile browser scenarios passed, including filtered/paginated audit review without viewport overflow. The disposable pinned Keycloak workflow passed all 10 scenarios. Its ignored local report is `.local/keycloak/run-FiUTAT/report.json`.

## Deliberate limitations and next step

Existing audit rows do not yet contain request IDs or typed changed-field metadata, so this slice does not invent those values or describe the log as tamper-proof. It provides no audit export, support impersonation, security-alert pipeline or platform-operator feed. Retention, deployed log aggregation and production review remain unresolved operational work.

Next P01-02 work is company/legal-entity, branch and effective-dated company-policy setup. Provider delivery reconciliation remains a production recovery gate, and all later entitlement, employee, attendance and payroll work remains unavailable.
