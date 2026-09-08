# Organization catalog evidence

Date: 8 September 2026. Scope: first bounded local P01-04 increment for tenant department and designation catalogs. This is not the employee lifecycle, assignment history, reporting-line validation, compensation, staging approval or production readiness.

## Delivered boundary

- Departments and designations have tenant-qualified IDs and unique normalized codes, bounded names, active/inactive status, optimistic versions and timestamps. Both tables use forced RLS and restrictive foreign keys; no hard-delete application command exists.
- The existing safe organization projection now includes bounded department and designation lists ordered with active entries first. Active owners and HR with recent MFA can read it. Only owners with recent MFA can create or version catalog entries.
- Strict create contracts never accept status, tenant, actor or version fields. Update requires the expected version, explicit state and reason. Duplicate tenant codes, no-op changes, stale versions, malformed values and cross-tenant identifiers fail closed.
- A constrained fixed-search-path database function serializes each tenant/catalog mutation, writes the catalog row plus tenant audit reason and versioned outbox event atomically, and returns only ID/version. The ordinary application role cannot query or mutate these tables directly.
- The responsive company-setup screen exposes separate department and designation lists/forms to owners and read-only lists to HR. It distinguishes create from edit and includes explicit status and reason only for versioned changes.

## Verification

- Contract and controller tests cover code normalization, mass-assignment rejection, exact catalog paths, Origin/CSRF proof, session-derived actor/MFA and typed create/update forwarding.
- PostgreSQL integration tests cover owner creation/update, HR projection, HR mutation denial, stale versions, audit reasons and direct runtime table denial. Existing legal employer, branch and policy history tests continue to pass with the expanded strict snapshot.
- Migration replay covers migration 17 and restricted-role bootstrap. The restore drill snapshots both new tables, creates records in two synthetic tenants and verifies all 27 forced-RLS business tables after restore.
- The existing organization browser scenario now creates both catalogs on desktop and mobile and retains the viewport-overflow assertion.

## Deliberate limitations and next step

No employee or assignment references these catalogs yet, so this slice does not claim in-use deactivation protection. There is no hierarchy between departments and no designation grade/pay behavior. Those meanings should be added only with validated employee and compensation requirements.

Next P01-04 slice: replace the minimal employee draft with required monthly-salaried employee details and effective-dated employment/branch/department/designation assignments, then add reporting-manager cycle prevention. Private details and separately authorized compensation history follow without exposing salary through the ordinary employee projection.
