# Protected company-provisioning evidence

Date: 30 August 2026. Scope: first protected P01-02 control-plane increment using synthetic local identities and data. This is not invitation activation or production identity-provider provisioning approval.

## Delivered

- Platform authority is stored in `platform_operators`, separate from company memberships and roles. The ordinary API role cannot read or write this table. An active operator must also have an active identity and recent trusted MFA.
- `POST /api/v1/platform/tenants` requires an existing server session, exact same-origin request, session-bound CSRF token, valid UUID `Idempotency-Key`, authentication no older than five minutes, and active platform-operator authority. Request data is strict and bounded; roles, identity IDs, tenant IDs and status cannot be supplied.
- One PostgreSQL operation creates the tenant, a `pending_identity_provider` initial-owner request, tenant audit record and global platform audit record atomically. It creates no identity or membership and returns no owner email. The company therefore has no user access until the later provider and invitation workflow succeeds.
- A caller-scoped idempotency key and advisory transaction lock serialize retries. Identical retries return the original identifiers; concurrent retries do not duplicate a tenant, request or audit event. Reusing the key with different data returns a conflict.
- The operation is a reviewed `SECURITY DEFINER` function owned by `kinto_control_owner`, a NOLOGIN, non-superuser, non-BYPASSRLS role with only the required table grants and RLS policies. The API retains no direct tenant, operator, provisioning-request or platform-audit write grant.
- `db:bootstrap:operator` is an explicit first-operator setup operation protected by migration credentials, exact OIDC issuer/subject inputs and a fixed confirmation value. It creates at most the first operator, records a global audit event, is idempotent for that exact active identity, and refuses replacement when another operator exists. No default operator or password is seeded.

## Verification

The local unit/API suite passed 62 tests. The PostgreSQL/Redis/OIDC integration suite passed 70 tests, including anonymous/missing-CSRF denial, unverified and stale MFA denial, active/revoked operator checks, strict request validation, HTTP replay, direct database permission denial, atomic audit persistence, concurrent replay and changed-payload conflict.

The isolated migration drill passed clean baseline installation, upgrade from the original foundation schema, database-role bootstrap, first-operator bootstrap, exact bootstrap replay, migration replay and two-tenant worker-delivery isolation. It proved one operator and one bootstrap audit record in the disposable database.

Final local verification passed: formatting, lint, TypeScript, documentation links, 62 unit/API tests with 100% selected coverage, 70 PostgreSQL/Redis/OIDC integration tests, the isolated migration/bootstrap/replay drill, the synthetic database recovery drill including pending company records, all production builds, 4 built-worker runtime tests, 12 desktop/mobile browser tests and 8 pinned real-Keycloak scenarios. The private ignored provider report is `.local/keycloak/run-lsekk2/report.json`; the private recovery report is `.local/recovery/2c5e411366f246e49efd5ca295bf40f0/report.json`. `pnpm audit --audit-level=high` reported no known vulnerabilities. Remote GitHub Actions remain unverified until the branch is pushed.

## Deliberate limitations and next step

This slice records an approved company and intended owner email, but it does not call the identity provider, send an activation link, create the owner identity, or grant an owner membership. Returning `202` with `pending_identity_provider` is deliberate: a failed or unavailable provider cannot create partial access. There is no company-provisioning UI or platform tenant listing yet.

Subsequent increments locally implement [initial-owner activation](owner-invitations.md), [employee account provisioning/activation](employee-account-activation.md), [owner membership administration with last-owner protection](membership-administration.md), [administrator invitations](administrator-invitations.md) and [server-side tenant selection](tenant-selection.md). Durable provider delivery/reconciliation remains a production gate; customer security-audit access remains pending.

Production also still requires callback reconciliation, identity-disable synchronization, approved email/provider infrastructure, secrets management, operator recovery/runbooks and staging review. Do not use this local path for real companies or personal data. See [authentication operations](../../operations/authentication.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
