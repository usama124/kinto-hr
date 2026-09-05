# Membership administration evidence

Date: 31 August 2026. Scope: bounded P01-02 membership listing, administrative role replacement and access revocation using synthetic local identities and tenants. This is not production identity-provider, customer security-audit UI or employee-offboarding approval.

## Delivered boundary

- An authenticated tenant owner with trusted MFA no older than five minutes can list memberships for the selected tenant. HR, payroll, employee, stale-MFA and cross-tenant callers are refused. The projection contains membership/identity IDs, status, roles, version, creation time and an employee-link marker; it does not expose provider issuer/subject, email, credentials or tokens.
- Role replacement accepts only a nonempty unique set of `owner`, `hr_admin`, `payroll_preparer` and `payroll_approver`. Revocation and role replacement require an expected positive version and a 3–240 character audit reason. Strict request contracts reject tenant, identity, status, `employee`, `platform_operator` and other mass-assigned fields.
- One fixed-search-path `SECURITY DEFINER` function owned by the constrained NOLOGIN control role rechecks active identity, active tenant, recent MFA and current owner membership. The runtime receives only function execution and has no unrestricted membership-update grant.
- Every tenant mutation takes the tenant advisory transaction lock. Removing/demoting an owner succeeds only while another active owner exists, so two concurrent final-owner attempts cannot both commit. Stale versions, no-op changes, revoked targets and cross-tenant IDs are rejected.
- Every successful mutation increments the membership version and atomically writes `membership.roles_changed` or `membership.revoked` with the authoritative actor and supplied reason. Employee-linked memberships are immutable at this boundary so administrator actions cannot bypass the future offboarding/provider-revocation workflow. Revoked administrative access has no reactivation route in this slice.

## Verification

- `pnpm test` passed 82 unit/API tests. New cases cover strict contracts, canonical role ordering, session-only actor derivation, stale-MFA downgrade, exact Origin/CSRF enforcement and mass-assignment rejection.
- `pnpm test:integration` passed 86 PostgreSQL/Redis/OIDC tests. New real-database cases cover owner-only listing, employee-link projection, canonical role updates, audit reasons, stale versions, cross-tenant/non-owner/missing-MFA denial, no-op refusal, revocation, employee-link protection and concurrent owner demotion with exactly one active owner preserved. Direct function calls also prove null MFA/version and whitespace-only reasons fail closed while PostgreSQL canonicalizes role ordering independently of the HTTP contract.
- `pnpm test:migrations` applied all nine migrations from a clean baseline and from the previous foundation schema, bootstrapped constrained roles and replayed with no pending migration. `pnpm test:recovery` preserved the membership role change and audit alongside pending/activated account state; its private ignored local fixture report measured 562 ms and sets `membershipAdministrationAuditPreserved=true`.
- `pnpm verify` passed formatting, lint, TypeScript, documentation links, all 82 unit/API tests and 100% measured contract/domain/configuration coverage. All application builds, four standalone worker/monitor checks and 12 desktop/mobile browser tests passed. The pinned real-Keycloak workflow passed all 10 password/TOTP/email/reset/revocation/owner/employee scenarios against the nine-migration schema.

## Deliberate limitations and next step

This slice manages existing administrative memberships only. It does not create/invite another administrator, reactivate revoked access, discover a user's tenant list, provide tenant-switch UI, display the customer security-audit feed or offboard an employee/provider account. The list currently uses opaque identity IDs because a tenant-safe administrator profile/email projection is not yet implemented.

Subsequent [administrator-invitation](administrator-invitations.md) and [tenant-selection](tenant-selection.md) increments implement owner-created fixed-role setup/activation and server-side company context. Next P01-02 work is customer-visible security-audit access, followed by company/legal-entity and effective-dated policy setup before employee CRUD is exposed. Provider delivery reconciliation, identity-disable synchronization and production recovery remain separate gates. See [authentication operations](../../operations/authentication.md), [Keycloak operations](../../operations/keycloak.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
