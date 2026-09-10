# Employee archive evidence

Status: locally verified · 10 September 2026 · P01-04 increment

## Delivered boundary

- Owner/HR users with recent MFA can explicitly move only a complete terminated employee with an ended employment period and final working date to archived. The command requires an optimistic version and audit reason.
- Archive records its timestamp, approving identity and reason on the employee, increments the version and emits reasoned audit plus `employee.archived.v1` outbox facts.
- Employment periods, dated assignments, employee number and public profile are retained. There is no hard-delete command, cascade or client-controlled history option.
- The command defensively revokes any linked tenant membership, employee account request and invitation that remained active. It never disables the global identity or changes another company's membership.
- Archived employees remain readable to authorized HR history and do not consume an active employee seat. The workspace displays the retained archived state and timestamp.

## Verification

- Strict contract/API tests reject mass-assigned deletion controls and derive actor/tenant only from the recent-MFA selected session.
- PostgreSQL tests cover complete-history retention, timestamp/actor/reason evidence, stale/premature/repeated/role/MFA/cross-tenant failures and runtime direct-write denial.
- The full integration suite, all 21 clean/upgrade/replay migrations and a synthetic backup/restore preserve active, scheduled and archived employee histories across two tenants.
- Desktop/mobile browser coverage exercises creation, activation, scheduled termination, worker-applied terminated state and archive. Build, worker runtime, Keycloak, formatting, lint, type checks, selected coverage and documentation links remain in the verification matrix.

## Remaining P01-04 work

Rehire into a new capacity-backed employment period is next. Private employee details, permission-separated compensation history and onboarding/offboarding checklists remain incomplete. This preview is not approved for customer data.
