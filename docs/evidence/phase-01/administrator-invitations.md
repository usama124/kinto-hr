# Administrator invitation evidence

Date: 1 September 2026. Scope: bounded P01-02 owner-created administrator request, provider setup delivery and exact-identity activation using synthetic local data. This is not production identity-provider, email or recovery approval.

## Delivered boundary

- `POST /api/v1/tenants/{tenantId}/administrator-invitations` requires a current server session, exact Origin/CSRF, UUID idempotency key, trusted MFA no older than five minutes and an active owner in the selected tenant. HR, employee, payroll-only, stale-MFA and cross-tenant callers cannot grant authority.
- The strict request accepts only a normalized email, mandatory 3–240 character audit reason and a unique nonempty subset of `owner`, `hr_admin`, `payroll_preparer` and `payroll_approver`. It rejects `employee`, `platform_operator`, tenant/identity/status injection and changed replay bindings. Roles are canonicalized independently in TypeScript and PostgreSQL.
- The request is access-neutral. Under the disabled-by-default reviewed Keycloak adapter, Kinto reconciles an exact provider identity, persists a forced-RLS invitation, then requests provider-managed verify-email/password/TOTP actions. Provider or persistence failure leaves the request pending and creates no membership.
- Exact issuer/subject plus trusted MFA atomically accepts an unexpired invitation and creates its fixed role set. Existing identities may join a different tenant, but any membership in the target tenant blocks the invitation, including revoked access. Reactivation requires a later explicit workflow.
- A cross-table database guard permits only one outstanding initial-owner, employee or administrator invitation for a provider identity. The runtime has no direct access to either new table and may execute only reviewed fixed-search-path functions owned by the NOLOGIN, non-superuser, non-BYPASSRLS control owner.

## Verification

- `pnpm test` passed 87 unit/API tests covering strict roles, normalized fields, session-only actor derivation, recent-MFA downgrade, exact CSRF/Origin, mass-assignment denial and administrator provider reconciliation/delivery ordering.
- `pnpm test:integration` passed 93 PostgreSQL/Redis/OIDC tests. Seven new cases cover access-neutral/idempotent requests, owner-only and tenant authority, concurrent same-email requests, exact-subject MFA activation and replay, existing cross-tenant identity, same-tenant conflict, private tables/function ownership and cross-type pending collision.
- `pnpm test:migrations` applied all ten migrations from clean and previous schemas, bootstrapped restricted roles and replayed cleanly. `pnpm test:recovery` preserved a pending administrator invitation; its ignored synthetic local report measured 695 ms and sets `pendingAdministratorInvitationPreserved=true`.
- All application builds, four standalone worker/monitor checks and 12 desktop/mobile browser scenarios passed. The pinned real-Keycloak workflow passed all 10 password/TOTP/email/reset/revocation/initial-owner/employee scenarios against the ten-migration schema.

## Deliberate limitations and next step

Provider delivery remains synchronous and disabled by default. There is no resend/revoke/failure queue, administrator invitation listing UI, customer audit feed, tenant chooser, revoked-access reactivation, identity-disable synchronization or production email/Keycloak approval.

Next P01-02 work is tenant discovery/selection and customer-visible security-audit access, followed by company/legal-entity and effective-dated policy setup before employee CRUD is exposed. See [authentication operations](../../operations/authentication.md), [Keycloak operations](../../operations/keycloak.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
