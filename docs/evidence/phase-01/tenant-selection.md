# Tenant discovery and selection evidence

Date: 5 September 2026. Scope: bounded P01-02 active-company discovery and Redis session selection using synthetic local identities and companies. This is not production identity-provider or customer security-audit approval.

## Delivered boundary

- Login discovers only active memberships in active companies. A constrained fixed-search-path PostgreSQL function returns the tenant ID/name, membership ID and fixed role set for the exact server-session identity; the browser receives only tenant ID/name/roles and ordinary runtime table access remains RLS-restricted.
- A sole available company is selected automatically at login. A multi-company identity receives no default and must choose through `PUT /api/v1/auth/tenant` with an exact Origin, current CSRF token and a strict tenant-ID-only body.
- The selected tenant is held only in the Redis server session. A successful change atomically compares and rotates CSRF while preserving idle/absolute expiry plus provider revocation indexes; concurrent reuse permits only one selection. No local/session storage, tenant header or provider role claim controls selection.
- Every implemented tenant-scoped HTTP controller requires the path tenant to equal the session selection before invoking its existing database authorization boundary. Selection grants no role or membership and never replaces PostgreSQL permission/MFA checks.
- Each session read re-discovers active access. A revoked membership, disabled identity or suspended company disappears; stale selected context is cleared and CSRF rotates before another tenant request can proceed.

## Verification

- `pnpm test` passed 88 unit/API tests, including strict selection input and denial when a tenant path differs from session context.
- `pnpm test:integration` passed 97 PostgreSQL/Redis/OIDC tests. New coverage proves safe active-only discovery, single-company defaulting, ordered multi-company discovery, Origin/CSRF enforcement, CSRF replay denial, unauthorized-tenant and mass-assignment denial, Redis-only selection and stale-selection clearing after revocation.
- `pnpm test:migrations` applied all eleven migrations from clean and previous schemas, bootstrapped restricted roles and replayed cleanly. The new discovery function is owned by the NOLOGIN, non-superuser, non-BYPASSRLS control owner and only its reviewed signature is executable by the runtime.
- `pnpm test:recovery` passed against the eleven-migration schema; its ignored synthetic local report measured 512 ms. All four standalone worker/monitor checks passed.
- All API, web and worker production builds passed. All 14 desktop/mobile browser scenarios passed, including the chooser without browser-side session storage. The pinned real-Keycloak workflow passed all 10 password/TOTP/email/reset/revocation/owner/employee scenarios with automatic single-company selection.

## Deliberate limitations and next step

Selection is an ephemeral security context, not a business record, and this slice does not add a tenant-switch audit event. Customer-visible security-audit querying, filtering, pagination and export remain unavailable. Company profile/policy administration and employee CRUD are still closed. Authentication remains disabled by default, and the existing production provider/recovery gates still apply.

Next P01-02 work is read-only customer security-audit access with strict tenant authorization and safe projections, followed by company/legal-entity and effective-dated policy setup. See [authentication operations](../../operations/authentication.md), [Keycloak operations](../../operations/keycloak.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
