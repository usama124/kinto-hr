# Employee account request evidence

Date: 31 August 2026. Scope: bounded P01-02 administrator-approved employee account request boundary using synthetic local data. This slice does not create a provider identity, send an invitation or grant membership.

## Delivered

- `POST /api/v1/tenants/{tenantId}/employees/{employeeId}/account-invitations` requires an existing server session, exact same-origin CSRF, a valid UUID idempotency key and trusted MFA no older than five minutes.
- One constrained PostgreSQL function rechecks the active identity, active tenant membership, tenant state and employee state. Only an owner or `hr_admin` membership in that exact tenant can request access. Employee, payroll and cross-tenant memberships are denied.
- The strict request body contains one normalized email. Callers cannot submit roles, identity IDs, membership state, tenant ownership or provisioning status. The eventual role is fixed by the specification to `employee`; this request creates no membership yet.
- `employee_account_requests` binds the request to an existing draft/active employee through a composite tenant/employee foreign key. One employee has at most one account request. Terminated/archived or cross-tenant employee selectors cannot be requested.
- An advisory transaction lock serializes requests for one employee. Exact retries and concurrent same-email requests return the existing request; reusing a key for different input or changing the intended email conflicts. Only the first request writes an audit event.
- The table uses forced RLS and is not directly readable or writable by `kinto_app`. The reviewed `SECURITY DEFINER` function is owned by the NOLOGIN, non-superuser, non-BYPASSRLS control owner with only required grants.

## Verification

Contract tests verify email normalization and reject invalid email, role and tenant-field injection. HTTP integration verifies anonymous, stale-MFA, missing-CSRF, mass-assignment and employee-role denial, plus safe idempotent responses with no email disclosure.

PostgreSQL integration verifies owner/HR authorization, cross-tenant and terminated-employee denial, exact replay, changed binding conflict, concurrent different-key serialization, one durable request/audit, no identity or membership creation, direct runtime-table denial and constrained function ownership.

The synthetic recovery drill includes a pending employee account request in its exact pre/post-restore snapshot and verifies forced RLS after restore. Clean and previous-schema migration replay includes all seven migrations.

Executed locally on 31 August 2026 with synthetic fixtures:

- `pnpm verify`: formatting, lint, TypeScript, documentation links and 77 unit tests passed; measured contract/domain coverage remained 100%.
- `pnpm test:integration`: 77 PostgreSQL/Redis integration tests passed across six files.
- `pnpm test:migrations`: clean baseline, seven-migration upgrade/replay and two-tenant isolation passed.
- `pnpm test:recovery`: restore passed and reported `pendingEmployeeAccountRequestPreserved=true`; the private ignored run report records a 455 ms restore for this local fixture only.
- `pnpm build`, `pnpm test:worker:runtime`, `pnpm test:e2e` and `pnpm test:keycloak`: all application builds, four worker runtime checks, 12 desktop/mobile browser tests and nine real-Keycloak scenarios passed.

## Deliberate limitations and next step

The request remains `pending_identity_provider`. This slice deliberately does not call Keycloak, send setup email, store a provider subject, activate a login, create an `employee` membership, expose resend/revoke operations or add an employee-facing UI. A successful `202` is therefore not active employee access.

The subsequent [employee activation increment](employee-account-activation.md) now implements exact provider reconciliation, expiring setup delivery and trusted-MFA activation that links one provider identity, one employee and one fixed `employee` membership without affecting owner/HR roles. Membership administration, last-owner protection, security-audit UI and production delivery/reconciliation remain later gates.

See [authentication operations](../../operations/authentication.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
