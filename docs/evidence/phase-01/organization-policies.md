# Organization and company-policy evidence

Date: 6 September 2026. Scope: bounded local P01-02 legal-employer, branch and typed organization-default policy administration using synthetic companies and identities. This is not production provider, payroll-policy, attendance-policy or legal-compliance approval.

## Delivered boundary

- Every tenant can have exactly one legal employer. Country, currency and time zone are server-controlled as `PK`, `PKR` and `Asia/Karachi`; the owner selects one supported ISO Pakistan province/territory code. Multiple branches belong to that employer, and branch codes are unique inside the tenant.
- An active owner with trusted MFA no older than five minutes can create or version the legal employer and branches, create immutable policy drafts, preview their effect and explicitly publish them. Owner and HR can read the selected company's organization snapshot; HR, payroll and employee roles cannot mutate it.
- The first typed `organization_defaults` policy supports only `defaultBranchId`. Draft effective dates use the Karachi calendar, optimistic base/version checks reject stale publication, and publication retains previous versions. Current policy resolution uses the latest published version effective on the requested current date; the snapshot separately reports the latest published version so future publications cannot cause conflicting drafts.
- A branch used by a current or future published default cannot be deactivated. IDs, tenant, actor, country/currency/time zone, policy domain/status/version and audit/outbox data are server-controlled. No hard-delete route is exposed.
- New tables use forced row-level security and composite tenant foreign keys. The ordinary runtime role has no direct table access and can call only constrained fixed-search-path functions whose control owner is NOLOGIN, non-superuser and non-BYPASSRLS.
- The responsive company-setup screen validates server responses, provides owner edit and HR read-only states, and separates draft preview from publication. It explicitly withholds attendance, leave, absence and payroll settings until those modules can validate and apply them.

## Verification

- `pnpm verify` passed formatting, lint, TypeScript, documentation-link validation and 98 unit/API tests with 100% measured selected coverage.
- `pnpm test:integration` passed 107 PostgreSQL/Redis/OIDC tests. Six new organization cases prove owner/HR read boundaries, employee/stale-MFA/cross-tenant denial, one-employer and fixed-localization invariants, legal/branch version conflicts, audit/outbox writes, default-branch deactivation protection, draft preview/publication, future/current version resolution and absence of direct runtime table access.
- `pnpm test:migrations` applied all fourteen migrations from clean and previous schemas, bootstrapped restricted roles and replayed with no pending migration. `pnpm test:recovery` restored two synthetic tenants including their legal employers, branches and published policy history in 835 ms; its ignored local report is `.local/recovery/8aca40565c6645e38c3edc6da1a7d433/report.json`.
- API, web and worker production builds passed. All four standalone worker/monitor checks and all 18 desktop/mobile browser scenarios passed, including legal-employer, branch, draft-preview and publication flow without viewport overflow. The disposable pinned Keycloak workflow passed all 10 scenarios; its ignored local report is `.local/keycloak/run-BzzICg/report.json`.

## Deliberate limitations and next step

This slice stores organization identity and one implemented default only. It does not validate a registration/tax number with SECP, FBR or any authority; model departments/designations; expose employee CRUD; configure shifts/attendance/leave/payroll; or establish a second legal employer. No arbitrary policy JSON or unimplemented rule toggle is accepted.

The P01-02 application boundary is now locally verified, while durable provider reconciliation, deployed recovery/alerts, staging and production approvals remain open. Next engineering work is P01-03 immutable plan versions, tenant subscription state, complimentary grants and authoritative capability/capacity resolution. P01-04 employee/compensation lifecycle and P01-05 imports/private files remain required before Phase 1 is complete.
