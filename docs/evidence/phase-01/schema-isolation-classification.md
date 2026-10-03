# Schema isolation classification

Local engineering increment on 3 October 2026, based on merged main `8f295c2` (PR 53). This closes the explicit table isolation/test classification gap in the [foundation review](foundation-acceptance-gaps.md). It is not a production security approval.

## Delivered boundary

The reviewed inventory in `scripts/schema-isolation.ts` classifies all 41 public business tables. Tenant records declare a non-null UUID scope column (`tenants.id` or `tenant_id`); private account/provisioning records are tenant control-plane records without ordinary tenant table access. Global identity, platform operator/audit and plan catalog tables have explicit separate classifications. `_prisma_migrations` is the only excluded public table.

`pnpm test:schema-isolation` compares the actual PostgreSQL catalog with this inventory. It requires enabled and forced RLS, exact policy names/commands/roles/permissiveness/read/write expressions, exact effective table privileges for the API/worker/dispatcher and both constrained function owners, and exact column-only privileges. Role safety includes non-superuser, non-BYPASSRLS, no role memberships and NOLOGIN function owners. The worker's existing five delivery-status update columns are explicitly allowed; extra column grants fail.

Each entry names an existing integration file and exact regression scenario. Missing scenarios, duplicate classifications, missing scope columns and unclassified/missing database tables fail verification. The catalog check does not prove a scenario's quality: review must still confirm that its fixtures/assertions cover the new table's domain boundary. Existing authorized two-company tests remain mandatory.

CI runs the dedicated command after migration/bootstrap. The same verifier also runs during isolated previous-schema upgrades and source/restored recovery snapshots. Existing independent restore-table whitelist and data equality checks remain; this increment changes no migration, policy, role grant, API or screen.

## Regression coverage

The existing database integration suite now checks the complete inventory and unscoped API-role reads across every classified table. Transactional synthetic catalog mutations verify rejection of unclassified tables and same-count table renames, disabled/unenforced RLS, permissive reads or writes, missing/additional policies, broadening control-owner policies to PUBLIC, PUBLIC table grants, column-only grants, widened worker update columns, BYPASSRLS, login-enabled function owners and nullable tenant columns. Every mutation is rolled back and the original catalog is reverified.

## Verification

- `pnpm verify`: formatting, lint, types, coverage thresholds and **173 unit/API tests** passed.
- `pnpm test:schema-isolation`: **41 business tables** passed the classification gate.
- `pnpm test:integration`: **178 tests in 19 files** passed.
- `pnpm test:migrations`: **46 existing migrations** passed isolated baseline upgrade, bootstrap/replay and classification checks; no new migration.
- `pnpm test:recovery`: synthetic source/restore classification, snapshot equality and existing lifecycle/retry/replay checks passed. Private evidence: `.local/recovery/a85516dcd43c41219c2e9fa9be8814fa/report.json` (ignored).
- `pnpm build`: API, web and worker passed.

No remote CI result is claimed. Browser/Keycloak and worker runtime suites are not rerun for this increment because there are no UI/authentication/runtime changes; their existing CI steps remain intact. The first sandboxed unit/API run could not bind HTTP listeners; the authorized local-listener rerun passed.

## Adding a table

Add reviewed SQL/RLS and bootstrap privileges, then explicitly extend the inventory with the tenant/global scope, exact policies/privileges and a real executed integration scenario. Extend domain fixtures and the independent recovery snapshot/restore assertions. Run `pnpm verify`, `pnpm test:schema-isolation`, `pnpm test:integration`, `pnpm test:migrations` and `pnpm test:recovery`. Do not auto-generate approved expectations from the live catalog or weaken policies merely to satisfy the check.

The checker targets this application's public business tables on PostgreSQL 16; new schemas, views, function authorization, file storage and deployed configuration require separate review. Deployed identity synchronization, staging/security approval, remote release evidence, backup/PITR/file recovery, production document storage/scanning and external Phase 0 decisions remain open.
