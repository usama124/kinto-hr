# Employee rehire evidence

Status: locally verified · 13 September 2026 · P01-04 increment

## Delivered boundary

- An owner or HR administrator with recent MFA can explicitly rehire only an archived monthly-salaried employee. The command requires the expected employee version, employer-local joining date, fresh active branch/department/designation, valid reporting assignment and audit reason.
- Rehire serializes the same authoritative subscription-capacity decision as first activation, moves the employee to active and atomically appends employment period N+1 plus its initial assignment. The employee number, original period, ended assignments, archive metadata and audit history are preserved.
- The new joining date must be today or later and strictly after the previous final working date. Stale, premature, repeated, cross-tenant, invalid-organization, invalid-manager and over-capacity attempts fail closed.
- Rehire emits `employee.rehired` audit and `employee.rehired.v1` outbox facts. It does not reactivate a revoked membership, invitation or account request; business employment and login restoration remain separate approvals.
- Authorized history reads expose every employment period, newest first. The employee workspace collects the new period and assignment and explains that login access remains revoked.

## Verification

- Strict contract/API tests reject client-controlled access restoration and derive actor/tenant only from the selected recent-MFA session.
- PostgreSQL tests preserve the original period/assignment byte-for-byte, append period two, enforce capacity and lifecycle rules and verify audit/outbox facts under forced RLS.
- All 22 clean/upgrade/replay migrations and the synthetic backup/restore retain an active rehired employee with two employment periods across both tenants.
- Desktop/mobile browser coverage exercises the complete create → activate → terminate → archive → rehire journey. Build, worker runtime, Keycloak, formatting, lint, type checks, coverage and documentation links remain in the verification matrix.

## Remaining P01-04 work

Private employee details, permission-separated compensation history and onboarding/offboarding checklists remain incomplete. Explicit post-rehire account reactivation also remains a separate security increment. This preview is not approved for customer data.
