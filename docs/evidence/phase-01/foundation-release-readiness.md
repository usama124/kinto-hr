# Foundation release-readiness review inventory

Local engineering increment, 3 October 2026, starting from merged main `538f11d` (PR 58). This is a review inventory and diagnostic command, not deployment approval or a new test runner.

## Implemented

[The committed inventory](../../implementation/foundation-readiness.json) lists nine local verification commands/evidence records, nine foundation review areas and four later-phase dependencies. Every gate is `review_required`; no person, hosting vendor, budget, release date or approval was invented. Foundation areas cover pilot scope, hosting, privacy/security, provider operations, storage/scanning, recovery, retention/support, staging acceptance and exact-revision remote CI. Later dependencies cover physical K50 evidence, lawful connector distribution, independent Pakistan payroll review and commercial billing. They do not imply that attendance or payroll are implemented or block safe synthetic work.

`pnpm foundation:readiness` reads the repository inventory, checks its structure/references and reports the current Git revision and dirty-workspace boolean. It prints JSON and exits **1** for review required; missing/malformed inventory, missing evidence, invalid arguments or unavailable Git yield generic diagnostics and exit **2**. It does not load `.env`, access a database/provider/cloud service, execute listed commands, read secrets, update runtime entitlements or provision anything. Git subprocesses have five-second deadlines and raw errors are suppressed. No public endpoint is added.

`pnpm foundation:readiness:verify` exits **0** for valid inventory, **2** for invalid inventory. This integrity check is included in `pnpm verify`, so CI rejects malformed or incomplete review inventories. Its success explicitly reports `productionAccepted: false` and `testsExecuted: false`. It is not a production readiness pass. The ordinary commands in `pnpm verify` still execute their real tests separately.

The JSON report always states `productionAccepted: false` and `testsExecuted: false`. Evidence records have the literal meaning `historical_local_evidence_not_current_test_result`. A current revision label or existing document never proves that its tests passed at that revision. No percentage or elapsed-time estimate is calculated from this inventory. Reports do not include changed filenames, Git remotes, record contents, credentials, tenant or employee values.

The strict schema requires the complete named foundation/dependency/evidence inventory, rejects duplicates, extra approval/bypass fields and unexpected status values, and checks that each referenced verification command exists in package scripts. Evidence must be nonempty Markdown inside the repository; traversal, absolute paths and escaping symlinks fail. Integrity validation does not judge evidence sufficiency or authenticate a human reviewer.

## Review workflow and boundaries

Run the real verification commands on the candidate revision, retain their actual exit/output and remote CI links through approved release procedures, then run the inventory report. A dirty report means the worktree differs from its reported commit, not that tests passed or failed. Share the report privately with the named reviewing roles and resolve the required evidence through approved staging/operational work. Store approvals in a separately reviewed process with approver identity, scope, date and candidate revision; this command cannot create, import or certify them.

There is deliberately no `--approve`, `--skip-gates`, mutable approval-status file or automatic production-ready result. Changing a JSON status to `approved` fails validation. If a future signed-review workflow is needed, it requires a reviewed contract change, not an environment override. This command controls no access/deployment mechanism and is not a substitute for protected release policies.

The existing safe defaults remain: no public signup, no live-data authorization, no public deployment/paid hosting purchase, no production document adapter, no automatic retention purge and no in-system salary transfer. Approved manual billing may proceed without an automated collection provider only under the separate commercial rules; this increment approves neither.

## Verification

- `pnpm verify`: formatting, lint, API/web types, coverage thresholds, **193 unit/API tests in 27 files**, documentation links and the new manifest integrity check passed.
- Four new script tests cover the real manifest, historical/current-result distinction, revision/dirty metadata, omitted/duplicate/falsely approved gates, unknown fields, unsafe commands/paths, missing verification commands, missing/empty/escaping/non-Markdown evidence, escaping manifest paths and CLI integrity/review/error exit codes.
- `pnpm foundation:readiness:verify` returned valid inventory with `productionAccepted: false` and `testsExecuted: false`. CLI tests verified review-required exit 1 and refused bypass exit 2. Script execution uses Node's tsx import hook without the tsx CLI's IPC listener; subprocess tests required normal subprocess permissions in this sandbox.

No API, database schema, provider protocol or business rule changed. Integration, migrations, recovery, builds, browser, worker-runtime and real Keycloak suites were not rerun for this inventory-only increment; their prior records are referenced explicitly as historical and existing CI steps remain intact. No current remote CI or production acceptance is claimed.

## Next work

Foundation remains locally implemented with production acceptance open. The next review should identify any remaining local contract gaps and assemble the approved staging/release exercise; provisioning, privacy, storage/scanning, delivered alerts and deployed recovery require the respective authorizations. Phase 2 attendance/leave implementation can use isolated synthetic contracts and connector tests while real K50 proof remains explicitly gated. No full phase completion is claimed by this inventory.
