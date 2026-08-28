# Worker foundation implementation evidence

Date: 28 August 2026. Scope: next local P01-01 worker/runtime slice. **Phase 1 remains incomplete; no staging or production approval.**

## Delivered

- Separate TypeScript worker package, production bundle and local development command; pinned BullMQ 5.81.4 with Redis 7.4.11 image digest, AOF and no-eviction local configuration.
- Transactional worker migration: durable delivery rows, unique consumer receipts, tenant-composite foreign keys, forced RLS, existing-event backfill and audit reasons. Trigger insertion rolls back with the source event.
- Restricted worker/dispatcher roles and a NOLOGIN metadata-function owner. No worker employee/payroll access and no direct dispatcher table access. The ordinary API role cannot enumerate all tenant jobs.
- Queue references contain only event/tenant UUIDs. Processing reloads the event under transaction-local tenant context, checks active tenant status and serializes handlers per tenant across processes.
- One foundation observer for `employee.activated.v1`, with receipt/completion atomicity, rollback of failed effects, five durable attempts, jitter, durable dead status, safe error codes and audited local operator replay. There are no employee updates, notifications, payroll calculations or external side effects in this handler.
- Dependency/status command, bounded startup/shutdown, structured heartbeat/failure logs, CI service/test/build wiring and an [operating guide](../../operations/foundation.md) describing local procedures and proposed staging controls.
- A repeatable isolated migration check applies the previous schema to an empty generated database, seeds two synthetic tenants/events, upgrades/backfills, verifies isolation and replays migrations. It cleans up only its own database.

## Verification

Local Linux, Node 22.23.2, pnpm 10.28.2, PostgreSQL 16 and Redis 7.4.11. Synthetic `kinto_test` records and UUID-named test queues only. Network/socket restrictions required approved elevated execution for service tests. The ignored local `.env` was extended only with missing worker settings; existing values were preserved.

Executed checks:

- Unit/API: 41 tests passed. Selected domain/contracts/API-and-worker-configuration coverage passed at 100%; this is not whole-worker/application coverage.
- Real PostgreSQL/Redis integration: 20 tests passed, including the original 10 database regressions.
- Isolated migration baseline/upgrade/backfill/replay and two-tenant delivery isolation passed.
- API, web and worker production builds passed. All 3 standalone worker runtime tests passed after fixing the signal-handler race below: real startup/SIGTERM shutdown, safe invalid-configuration failure and a bounded Redis-unavailable startup.
- All 8 desktop/mobile browser regressions passed. No web UI behavior was changed in this slice.
- `pnpm verify:full` passed end to end: formatting, zero-warning lint, root/web typechecks, selected coverage gates, 10 planning documents/39 local links, integration tests, isolated migration verification, all builds, worker runtime checks and browser journeys.
- `pnpm worker:check` passed against the local restricted database roles and Redis, reporting no pending/dead fixture deliveries after cleanup.
- `pnpm install --offline --frozen-lockfile --store-dir /tmp/kinto-pnpm-store` passed after the network-enabled dependency install populated that local store. `pnpm audit --audit-level=high` reported no known vulnerabilities.
- `.env`, worker `dist` output and worker `node_modules` remain ignored. `git diff --check` passed. No generated clients, runtime secrets or browser reports are included in the source change.

Final full command, from the root after exporting local `.env` settings and with Node/pnpm on PATH:

```bash
PLAYWRIGHT_BROWSERS_PATH=/tmp/kinto-playwright pnpm verify:full
pnpm worker:check
```

These are local results: **72 automated test cases passed**, plus the isolated migration scenario and other checks. Remote GitHub Actions status is not asserted.

## Defects caught during implementation

- Prisma requires composite uniqueness on both sides of these tenant/event one-to-one relationships. The migration/schema now agree and generation succeeds.
- The replay tooling needed its own declared Zod dependency rather than relying on a transitive installation. Typecheck and integration tests caught it.
- The real production-process test sent SIGTERM immediately after `ready` and found signal handlers were installed too late. They are now registered before waiting for startup; the regression is retained.

## Boundaries and remaining work

The consumer registry intentionally supports only the foundation observer. The full actor/correlation envelope, user/membership/entitlement authorization, business job progress UI, notifications, imports and scheduled payroll are not implemented by this slice. Multiple independent consumers need consumer-keyed delivery rows before fan-out is introduced. The local replay tool relies on operator access to local migration credentials, not a fabricated authenticated user session.

PostgreSQL failure can prevent recording an attempt; durable handler retry limits do not impose a global infrastructure-reconnection cap. Queue recovery is tested through removal/redispatch and duplicate delivery after completion; this is not a live production disaster-recovery exercise.

Still outstanding: OIDC/MFA and membership permissions; protected company/policy administration; immutable plans/entitlements; full employee/compensation workflows; imports/private files; actual database/file restore evidence; operational metrics/alerts; approved staging and security review. The staging description is a document, not deployed infrastructure. GitHub Actions execution must be verified after pushing; previous runs were blocked by the account billing issue, not evidence of test execution.

Subsequent update: the [recovery/monitoring increment](recovery-monitoring.md) adds local database restore evidence, worker leases and private metrics. File/PITR/deployed recovery and alert notification delivery remain outstanding; the earlier 72-test count above describes this worker slice only.
