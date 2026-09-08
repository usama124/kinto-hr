# Employee records and effective assignments evidence

Status: locally verified · 9 September 2026 · P01-04 increment

## Delivered boundary

- `POST /api/v1/tenants/{tenantId}/employees` creates a draft only after strict monthly-salaried, organization-reference and reporting validation. The server supplies tenant, actor and resource identifiers.
- `GET /employees` and `GET /employees/{id}` return owner/HR projections with current and historical organization assignments. `PUT /employees/{id}` versions public names; `POST /employees/{id}/assignments` appends a dated assignment.
- Initial creation atomically writes the employee, first planned employment period, first assignment, audit reason and outbox event. A missing manager requires a documented top-level exception.
- Assignment changes are append-only from the latest assignment, cannot begin in the past, close the preceding interval, and recursively reject direct/indirect reporting cycles at the new effective date.
- Employee number uniqueness and every organization/manager relationship are tenant-qualified. Inactive organization references, missing/revoked access, stale versions, cross-tenant identifiers and direct runtime access to the new tables fail closed.
- Public employee projections contain no salary, bank, CNIC, contact or emergency data and explicitly report payroll setup as incomplete. Those fields require later separately authorized storage.
- The responsive employee workspace lists records and creates complete drafts only when an active branch, department and designation exist.

## Verification

- Contract/API tests cover normalization, unsupported worker types, manager/exception exclusivity, salary mass-assignment rejection, CSRF, selected-tenant binding and recent-MFA propagation.
- Real PostgreSQL tests cover owner/HR authority, employee and stale-MFA denial, tenant-scoped duplicate numbers, cross-tenant not-found behavior, inactive references, version/no-op conflicts, effective history and cycle rejection.
- Migration verification applies all 18 migrations to clean, upgrade and replay databases. Recovery compares all 29 business tables and complete employee period/assignment fixtures across two synthetic tenants.
- Desktop and mobile browser checks cover employee draft creation, setup references, incomplete-payroll messaging, private-data boundary and viewport overflow.

## Remaining P01-04 work

Explicit capacity-backed activation must be connected to the complete record, followed by scheduled termination/archive, access revocation, rehire periods, private details, permission-separated compensation history and onboarding/offboarding checklists. This increment is not a complete employee lifecycle and is not approved for customer data.
