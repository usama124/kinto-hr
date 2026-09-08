# Base plan and entitlement evidence

Date: 8 September 2026. Scope: first bounded local P01-03 immutable plan catalog, tenant base subscription, effective capacity read and activation enforcement using synthetic companies and identities. This is not pricing, invoicing, payment collection, grant/override administration or production approval.

## Delivered boundary

- The migration seeds immutable version-1 Free 5, Starter 20, Growth 50, Business 100 and Scale 250 plan records. They contain no price and only the implemented `companySetup` capability; a database trigger refuses update/delete.
- Platform provisioning accepts only the five package capacities, restricts Free to five employees and atomically creates one active base subscription with the company request. Complimentary billing keeps the chosen package/capacity while creating no payment obligation and granting no role permission.
- Existing tenants are backfilled without increasing their legacy employee limit: each receives its exact capacity snapshot linked to the smallest plan that contains it. Fresh application provisioning uses exact catalog capacities. The legacy tenant field remains a transitional fallback only for direct post-migration synthetic fixtures; application-provisioned and migrated tenants have subscriptions.
- `GET /api/v1/tenants/{tenantId}/entitlements` requires the selected tenant, active owner/HR membership and trusted MFA no older than five minutes. Its strict projection contains package/version, billing mode, effective employee limit, live active count, available seats, implemented capabilities and entitlement version/effective timestamp.
- Employee activation retains the transaction-scoped tenant advisory lock and uses the current subscription capacity when present. A stale larger legacy tenant value therefore cannot permit an extra activation. The responsive plan screen is informational; the database remains authoritative.
- Plan catalog access is denied to the ordinary runtime. Tenant subscriptions use forced RLS; the runtime receives tenant-scoped subscription read only for the existing activation transaction. The entitlement function is owned by the constrained NOLOGIN, non-superuser, non-BYPASSRLS control role.

## Verification

- `pnpm verify` passed formatting, lint, TypeScript, documentation-link validation and 101 unit/API tests with 100% measured selected coverage.
- `pnpm test:integration` passed 110 PostgreSQL/Redis/OIDC tests. Three new entitlement cases prove the exact five-record catalog, plan mutation denial, runtime catalog denial, owner/HR safe reads, employee/stale-MFA/cross-tenant denial, live usage calculation, subscription precedence over the legacy column and one-success final-seat concurrency. Existing platform tests also prove atomic Starter/complimentary subscription creation and invalid Free capacity rejection.
- `pnpm test:migrations` applied all fifteen migrations from clean and previous schemas, including legacy-capacity backfill, restricted-role bootstrap and replay with no pending migration. `pnpm test:recovery` restored the catalog and tenant subscription in 1,012 ms; its ignored local report is `.local/recovery/7cbdd98bf50c4a65938951f9ea222a40/report.json`.
- API, web and worker production builds passed. All four standalone worker/monitor checks and all 20 desktop/mobile browser scenarios passed, including safe complimentary-plan/capacity display without viewport overflow. The disposable pinned Keycloak workflow passed all 10 scenarios; its ignored local report is `.local/keycloak/run-1wWXD2/report.json`.

## Deliberate limitations and next step

These are technical package seeds, not commercial offers: prices, taxes, accepted paid agreements, invoices, renewal, downgrade/grace behavior and payment collection do not exist. The only capability is company setup; an entitlement cannot bypass tenant status, membership role, data scope or module availability.

The remaining P01-03 controls are now locally implemented and recorded in [dated entitlement-control evidence](entitlement-controls.md). P01-04 employee/compensation lifecycle and P01-05 imports/private files remain required before Phase 1 is complete.
