# Employee account activation evidence

Date: 31 August 2026. Scope: bounded P01-02 provider reconciliation, setup delivery and exact-identity activation for a previously approved employee account request using synthetic local data. This is not production identity-provider or email approval.

## Delivered boundary

- The protected owner/`hr_admin` request endpoint now invokes the disabled-first Keycloak adapter after the database has accepted the tenant-scoped employee request. A provider or persistence failure leaves the request at `pending_identity_provider` and grants no access.
- Provider reconciliation creates a disabled, request-marked user or accepts one exact existing enabled account only when Keycloak reports its email verified. Established accounts are not mutated with Kinto marker attributes. Disabled retry reconciliation still requires the original request marker.
- Kinto persists `employee_invitations` before requesting the provider-managed 48-hour `VERIFY_EMAIL`, `UPDATE_PASSWORD` and `CONFIGURE_TOTP` delivery. Kinto stores no setup token or password.
- Trusted MFA by the exact reconciled issuer/subject atomically accepts the invitation, creates one active membership with roles exactly `['employee']`, creates one durable employee-to-identity link and marks the request active. Wrong identity, missing MFA, expiry, terminated employees, an existing same-company membership, replay and concurrent callbacks grant no additional access.
- Pending owner and employee activations for one provider identity are mutually excluded under one advisory identity lock. This prevents an employee flow from replacing, extending or modifying owner/HR access.
- Both new tables use forced RLS. The runtime has no direct table access and may execute only reviewed fixed-search-path functions owned by the NOLOGIN, non-superuser, non-BYPASSRLS control owner.

## Verification

- `pnpm verify` passed formatting, lint, TypeScript, documentation links and 78 unit tests with 100% measured contract/domain coverage.
- `pnpm test:integration` passed 80 PostgreSQL/Redis/OIDC tests, including concurrent employee activation, fixed role/link creation, wrong identity, expiry, existing-membership conflict, bidirectional owner/employee pending-identity collision, direct runtime denial and constrained function ownership.
- `pnpm test:migrations` passed a clean baseline, all eight migrations, role bootstrap and replay. `pnpm test:recovery` restored exact pending and active employee account state with `activeEmployeeIdentityLinkPreserved=true`; the private ignored report measured 460 ms for this local fixture only.
- `pnpm build`, `pnpm test:worker:runtime` and `pnpm test:e2e` passed all application builds, four standalone worker/monitor checks and 12 desktop/mobile browser regressions. The pinned real-Keycloak workflow passed 10 scenarios, including owner-authorized employee setup email delivery and exact provider subject plus TOTP activation into one fixed employee membership/link.

## Deliberate limitations and next step

Delivery is synchronous. There is no durable provider command queue/inbox, alert, resend/revoke UI, failed-request operator workflow or identity-disable synchronization. Production Keycloak permissions, email, secrets, callback availability and recovery remain unapproved. Authentication and provisioning remain disabled by default.

Subsequent [membership-administration](membership-administration.md), [administrator-invitation](administrator-invitations.md) and [tenant-selection](tenant-selection.md) increments implement bounded owner role/revocation changes, last-owner protection, fixed-role administrator setup and server-side company context. Next P01-02 work is customer-visible security audit, followed by company/legal-entity and effective-dated policy setup before employee CRUD is exposed. See [authentication operations](../../operations/authentication.md), [Keycloak operations](../../operations/keycloak.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
