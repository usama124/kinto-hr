# Device employee mapping workspace

Date: 7 October 2026. Scope: preparatory P02-01 screen, not hardware/attendance acceptance.

## Implemented behavior

`/device-mappings` is linked from workspace navigation. Owners create mappings and confirm versioned interval shortening; HR can only read history and resolve identifiers at event time. Retired devices retain readable/endable assignments but cannot receive new mappings. Archived employees are excluded from creation; historical missing employee names are shown as UUIDs rather than guessed identities.

Inventory uses independent bounded 25-item device and mapping pages. Strict schema, ordering, uniqueness, cursor and tenant/device binding checks reject malformed projections. Resolution calls the full-history server endpoint and displays mapped, unmapped or ambiguous results without guessing an employee. Result labels are erased when lookup inputs change, another operation begins or metadata refreshes. Times are shown in UTC; inputs require UTC or an explicit offset such as +05:00, never the browser's assumed local timezone.

A fresh server session supplies company/identity/role and ephemeral CSRF for reads, writes and exact retry. No CSRF or employee information is persisted to browser storage. Company/actor/role changes clear pending attempts and company forms/data at the next session check. Denied/malformed/unavailable reads clear the displayed snapshot and draft inputs. Refresh and pagination never dispatch a mutation.

Every create/end attempt retains its original UUID key, payload, tenant, identity and device in component memory. Unknown network/server/malformed-receipt outcomes block new writes, including after metadata refresh. Retry obtains a fresh session/CSRF but cannot change the original request or replay it as another actor. A successful retry can return replayed=true or replayed=false: a failed transport may not have reached the server originally; the database receipt still protects the same key from duplication. Create receipts require original version 1; end receipts must match the original mapping ID and expected next version. Rejected 400/409 commands and confirmed outcomes require refreshed versions before another write.

End confirmation can be cancelled without a POST. Client interval checks improve feedback; SQL remains authoritative for overlap, permissions, optimistic versions and idempotency. There is no automatic mutation retry, deletion, ID coercion, overlap replacement, enrollment, device activation or attendance/payroll effect. Pending reconciliation survives an in-page refresh, not navigation/browser/process restart; after leaving, inspect authoritative history before a new command.

## Verification scope

Desktop/mobile browser cases use synthetic intercepted company, employee, device and mapping responses to exercise UI boundaries. They do not replace the real PostgreSQL/HTTP mapping tests from the [API increment](device-employee-mappings.md). Focused desktop/mobile suite: all 32 new scenarios passed, including an undispatched write's first execution on exact retry, wrong end-receipt identity, malformed cursor/duplicate rows, leading-zero IDs, explicit offsets, confirmed ending, HR/retired restrictions, pagination, unresolved lookup and actor/company changes.

`pnpm verify` passed: formatting, lint, root/web types, 270 unit/API tests, coverage thresholds, documentation links and readiness manifest. All 237 integration tests passed. API, web and worker builds passed. The initial browser launch failed because local test services were stopped; the existing synthetic PostgreSQL/Redis services were started, all 54 migrations were already applied, and runtime grants were bootstrapped before rerunning tests. No customer data was seeded. The complete desktop/mobile browser regression passed all 178 tests, including the 32 new mapping scenarios. Schema isolation, disposable migration replay, recovery drill, provider acceptance and built-worker runtime tests were not rerun for this UI-only increment. Production readiness remains unaccepted.

No database migration, API authority, connector admission or worker behavior changes in this increment. Hardware proof, source-event identity/deduplication, raw ingestion/exception processing, locked-period safeguards, credential rotation and production admission remain pending. Next bounded work: synthetic durable raw attendance ingestion preparation, without selecting an unverified hardware adapter/runtime or enabling production machine access.
