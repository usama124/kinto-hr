# Dated entitlement-control evidence

Date: 8 September 2026. Scope: remaining local P01-03 application boundary for operator-managed capacity/complimentary grants, one field override, preview, revocation, expiry and entitlement versions. This is not pricing, invoicing, payment collection, deployed staging evidence or production approval.

## Delivered boundary

- A forced-RLS entitlement state gives each subscribed tenant an increasing version. Dated grants are either additive capacity or a complimentary package capacity; overlapping grants are allowed and resolved deterministically. The only supported explicit override is `employee_limit`, which replaces the otherwise effective capacity while active.
- Active overrides for the same tenant and field cannot overlap. The operator function checks before insertion and a database trigger preserves the invariant under concurrent or direct privileged writes.
- Platform routes accept strict request shapes for preview, create and revocation. They derive identity and recent MFA from the server session, require exact Origin/CSRF mutation proof, and delegate authorization to constrained database functions. Company users cannot create these controls merely because they can read their own effective plan.
- Preview evaluates the proposed change at its start time without persistence. Create and revoke use a tenant entitlement advisory lock, increment the entitlement version and write both tenant and platform audit events; the tenant event preserves the required reason. Revocation updates immutable history rather than deleting it and rejects stale versions or cross-tenant identifiers.
- Effective resolution uses database time. Additive capacity increases employee activation capacity, complimentary access reports complimentary billing without creating a payment obligation, and an active override takes precedence. Expiry returns to the accepted base subscription, preserves every employee/history row, reports zero available seats when over cap, and prevents further activations.
- The ordinary runtime cannot write grants/overrides directly. The reviewed functions are owned by the existing constrained NOLOGIN, non-superuser, non-BYPASSRLS control role. Allocation reads current entitlements inside the existing serialized activation transaction; old direct synthetic tenants without a subscription retain the documented legacy fallback.

## Verification

- `pnpm verify` passed formatting, lint, TypeScript, documentation-link validation and 106 unit/API tests with 100% measured selected coverage. Contract cases reject unbounded, mixed and mass-assigned change fields; controller cases cover recent/stale MFA, CSRF, strict paths and revocation kinds.
- `pnpm test:integration` passed 114 PostgreSQL/Redis/OIDC tests. Four new scenarios cover additive capacity plus activation, a temporary complimentary 100-seat tenant, expiry while over cap without deletion, override precedence, database overlap protection, direct runtime-write denial, non-operator/stale-MFA denial, cross-tenant and stale revocation, version increments and retained audit reasons.
- `pnpm test:migrations` applied all sixteen migrations from clean and prior schemas, bootstrapped restricted roles, verified legacy backfill and replayed with no pending migration.
- `pnpm test:recovery` restored entitlement state and a live grant with the catalog/subscription and compared every row. The report remains ignored under `.local/recovery`; the drill still excludes file storage and point-in-time recovery.
- Production builds, the standalone worker checks, desktop/mobile browser scenarios and the disposable pinned Keycloak workflow are included in `pnpm verify:full`.

## Deliberate limitations and next step

No price, invoice, payment, renewal, downgrade or automatic collection behavior exists. Expiry only reveals the already accepted base subscription. Capability grants are intentionally absent because company setup is still the sole implemented module; adding flags for unavailable modules would misrepresent product readiness. There is no operator commercial dashboard or tenant listing yet; these bounded endpoints support controlled administration and later UI work.

P01-03 is locally complete. Next is P01-04: complete organization/employee lifecycle, effective-dated assignments, private-data permissions and effective-dated compensation capture/history. P01-05 imports/private files and all operational/staging gates remain before Phase 1 completion.
