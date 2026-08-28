# Recovery and monitoring foundation evidence

Date: 28 August 2026. Scope: local P01-01 recovery/operations increment. **Foundation and Phase 1 remain incomplete; this is not production recovery or staging approval.**

## Delivered

- `pnpm test:recovery`: actual PostgreSQL custom-format dump and transactional restore into an empty generated database, using the existing test container's tools. Verifies cluster identity before fixture creation and never backs up/overwrites the working database. CI runs the same command with its PostgreSQL service container ID.
- Two synthetic employers; exact comparison of all six current business tables; a post-backup record excluded from the restored snapshot; restored FORCE RLS, runtime role safety, company isolation and rejected cross-company writes. Completed deliveries remain completed with one receipt, pending work resumes once and dead jobs retain their exhausted attempts. Restored migrations replay with none pending.
- Archive SHA-256 verification, corruption rejection and private ignored dump/report artifacts. The drill removes only databases it generated. No project schema or migration changed in this increment.
- Redis-time worker heartbeat leases scoped to queue and instance; graceful removal, expiry after process loss, and aggregate active-worker counts. Worker availability is no longer inferred from dependency connectivity alone.
- A separate loopback-only operational monitor with aggregate Prometheus metrics and readiness alert codes; no tenant labels, employee data or public business endpoints. Five-second collection deadlines, shared concurrent collection, sanitized failure responses and explicit dependency-failure metrics.
- `worker:check` returns nonzero for missing worker, dependency failure, dead delivery or oldest work at least five minutes overdue. Monitor deployment only needs dispatcher/Redis credentials. Live alert routing/scraping infrastructure is not provisioned.

## Verification record

The first local recovery drill passed on PostgreSQL 16 using Node 22.23.2 and pnpm 10.28.2. It produced a 27,769-byte synthetic archive; the measured `pg_restore` operation took 169 ms. This is a tiny local fixture timing, **not a production RTO**. Its private report is `.local/recovery/f1fab67093334ce783eaa443ac093bd0/report.json`; artifacts are ignored and not committed. The drill verified the archive's SHA-256 and cleaned up both generated databases.

Final `pnpm verify:full` passed end to end:

- 46 unit/API/monitoring tests, 21 real PostgreSQL/Redis integration tests, 4 built worker/monitor runtime tests, and 8 desktop/mobile browser tests: **79 test cases passed**.
- The live-process test verifies monitor 503 with no worker, 200 after a worker starts, and 503 after graceful shutdown; `worker:check` exits 0/1 accordingly. The monitor runs without worker/API/migration database credentials. Missing configuration and unavailable Redis fail safely.
- Isolated migration upgrade/backfill/replay and the real restore drill passed. The full-suite restore report is `.local/recovery/7f465c9ace6145f4a19c7553553b01e0/report.json` (27,758 bytes, 180 ms restore). Synthetic data and archive timestamps make checksums/sizes vary per run.
- Formatting, zero-warning lint, root/web typechecks, selected coverage gates, 10 planning documents/42 local links and all API/web/worker/monitor production builds passed. Selected domain/contracts/configuration coverage was 100%; this is not whole-application coverage.
- Frozen offline dependency installation and `git diff --check` passed. No dependency versions changed. Local recovery directory/archive/report permissions were verified as 0700/0600/0600, and the artifacts remain ignored.

Executed from the root with the local test settings exported and Node/pnpm on PATH:

```bash
pnpm test:recovery
PLAYWRIGHT_BROWSERS_PATH=/tmp/kinto-playwright pnpm verify:full
```

No remote GitHub Actions result is claimed. CI now runs recovery with its service container ID supplied at the recovery step, and tests `worker:check` with a real running worker rather than expecting success when none exists.

The installed BullMQ version exposes an adapter interface rather than declaring all native Redis methods. Typechecking caught initial native-method usage; heartbeat scripts now use the adapter's `defineCommand`/`runCommand` contract. Existing worker behavior is retained and tested.

## Remaining foundation work

**Next engineering slice: P01-02 identity and access.** OIDC/MFA, secure sessions, membership selection/invitations/revocation, tenant/role authorization and protected company/policy administration must exist before business HTTP endpoints are exposed.

The wider Phase 1 also still requires immutable plans/complimentary entitlements, full employee and effective-dated compensation workflows, imports, private documents and self-service. Leave, K50 connectivity and payroll remain later phases.

Operational acceptance is still incomplete: hosting/region/privacy approvals, scheduled encrypted backups and PITR, recovery on a fresh cluster with provisioned roles, private-file restore, scraper/alert notification delivery, staging smoke tests, security review and verified remote CI. The new drill is a real logical database restore on an existing local cluster, not evidence of those unimplemented services. No customer records, biometrics, live payroll, paid resources or public deployment were used.
