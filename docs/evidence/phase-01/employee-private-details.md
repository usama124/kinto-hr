# Employee private details evidence

Date: 13 September 2026  
Scope: P01-04 restricted contact, emergency-contact, residential address and CNIC records.

## Implemented boundary

- Owner and HR administrators with recent MFA can explicitly load and version private employee details through dedicated endpoints and the employee workspace.
- Values live in `employee_private_details`, separate from roster and public employee projections, under forced tenant RLS. The application role has no direct table access.
- Commands require an audit reason and optimistic version. Audit and outbox rows contain employee references and versions, never private values.
- Employee, payroll-only and cross-tenant principals are rejected. Terminated and archived records remain readable for retention but cannot be edited.
- Bank and compensation fields are rejected by the strict contract and remain reserved for the separately authorized compensation increment.
- CNIC validation checks format only; it does not claim government verification.

## Verification

Contract, domain, API and PostgreSQL integration tests cover normalization, strict input rejection, recent MFA, roles, cross-tenant isolation, stale writes, public-projection exclusion, direct-table denial and sanitized audit/outbox records. Migration replay and synthetic backup/restore include the forced-RLS table and its records.

No production data, government verification service or encryption key was introduced. Field encryption remains a deployment security-review decision before live personal data is accepted.
