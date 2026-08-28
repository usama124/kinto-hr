# Foundation operating guide

Status: local development procedures and proposed staging controls. No staging or production environment has been provisioned or approved. Use synthetic records only.

## Services and credentials

The web, API and worker are separate processes. `pnpm dev` starts all three; `pnpm --filter @kinto/worker dev` starts just the worker. PostgreSQL and Redis run through `infra/compose.yaml`, bound to localhost at ports 55432 and 56379 by default. Redis uses AOF and `noeviction`; its queue is recoverable from PostgreSQL, not the authoritative event store.

Existing checkouts must add the new `WORKER_DATABASE_URL`, `DISPATCHER_DATABASE_URL` and `REDIS_URL` settings from `.env.example` to their local `.env`, preserving existing credentials and database ports. Then export the settings and run:

```bash
docker compose --env-file .env -f infra/compose.yaml -p kinto-hr up -d --wait
pnpm db:generate
pnpm db:migrate
pnpm db:bootstrap
pnpm worker:check
pnpm dev
```

Do not give migration credentials to a deployed web/API/worker process. The local `.env` combines fixture credentials for convenience; deployed secrets must be injected separately per service. No real passwords belong in `.env.example`, container arguments, queue payloads or logs. The local Redis service has no authentication and must not be exposed beyond a trusted development host.

The database boundaries are:

- `kinto_app`: existing tenant-scoped employee/audit/outbox permissions; no delivery mutation or cross-tenant dispatch function.
- `kinto_worker`: tenant-scoped tenant/event reads, delivery status updates and receipt insertion. No employee, compensation or audit access; no outbox writes.
- `kinto_dispatcher`: execution of `pending_outbox(100)` and `outbox_health()` only. No direct business-table access.
- `kinto_outbox_owner`: a NOLOGIN, non-superuser, non-BYPASSRLS role with delivery-metadata SELECT/INSERT only. It owns the reviewed, fixed-search-path functions. A dedicated policy permits those functions to enumerate delivery metadata; it does not expose HR tables. No application role may be a member of this role.

The local bootstrap script requires all four database URLs to target the same local `kinto_*` database and refuses an unsafe role. It is not a production account-provisioning system. Roles are cluster-wide; do not use this local bootstrap against a cluster shared with unrelated applications. The isolated migration test reuses these same local fixture credentials.

## Processing, failure and replay

An outbox insert creates its delivery row in the same transaction through a restricted trigger. Existing events are backfilled by the worker migration. The dispatcher polls up to 100 due references every two seconds. Redis holds only `{ eventId, tenantId }`; the worker loads the immutable event from PostgreSQL under transaction-local tenant context. UUID job IDs reduce queue duplicates, while PostgreSQL locks and the unique receipt enforce durable deduplication even after Redis forgets a job.

Only `employee.activated.v1` is supported. Its foundation consumer records that it observed the committed fact; it does not update employees, send notifications, calculate payroll or transfer salaries. There is one consumer/receipt per event in this slice. Multiple independent subscribers will need a consumer-keyed delivery model before being enabled. The full event envelope and membership/entitlement checks for future user-requested jobs remain part of later slices; a queue reference is never permission to execute those jobs.

Processing rechecks active tenant status. Across worker processes, a PostgreSQL advisory lock permits at most one handler transaction per tenant; other companies can proceed concurrently, up to four jobs per process. Busy or not-yet-due deliveries consume no durable attempt. Handler effects, receipt and completion commit together. A savepoint rolls failed handler changes back before recording a sanitized failure code.

Handler failures get at most five durable attempts with exponential delay and 50% jitter, then become `dead`. An unsupported event or suspended company is never acknowledged as completed. Redis transport failures have a separate five-attempt queue budget. If PostgreSQL itself is unreachable, a durable failure cannot be recorded; the dispatcher resumes from the unchanged row after service recovery. This is not a five-attempt limit on infrastructure reconnection. A missing queue job is redispatched until PostgreSQL records completion/dead status. Completed/dead records and receipts are retained; there is no automatic database purge.

`pnpm worker:check` checks database/Redis dependencies and prints aggregate delivery counts/oldest timestamps, without employee data. It exits nonzero for dead deliveries. It does **not** prove that a separate worker process is alive. The worker logs `ready`, a successful dispatch heartbeat every 30 seconds, and safe infrastructure failure categories. It never logs raw database errors, URLs or job payloads. Monitor the process separately and alert on growing due age, any dead delivery, missing heartbeat and repeated connection errors. A metrics exporter, alert delivery and a protected job dashboard are not implemented yet.

Local operator investigation can query the dedicated fixture database for `job_deliveries` using the migration account; never grant that account to customer HR users. After diagnosing the cause and restoring an active company, a local operator can replay one dead delivery:

```bash
pnpm worker:replay TENANT_UUID EVENT_UUID OPERATOR_UUID "Reason for the replay after investigation"
```

Use actual UUIDs. The reason must be 10–240 characters and contain no personal information. The command accepts local `kinto_*` databases only, rejects completed/non-dead/foreign-company events, and atomically resets attempts with an audit record. The UUID identifies the local operator's assertion; this CLI is protected by access to local migration credentials, **not** an implemented OIDC session. Never expose it as an HTTP endpoint. Production replay requires the future authenticated control-plane authorization and operator workflow.

On SIGTERM/SIGINT the worker stops dispatching and drains processing, with a 15-second shutdown deadline. Startup fails if readiness cannot be established within 15 seconds. If forced termination interrupts a transaction, PostgreSQL rolls it back; any queue redelivery must still acquire the database lock/check the receipt. Do not delete receipts to “retry” completed work.

## Verification and migration safety

`pnpm verify:full` includes unit/API tests, real PostgreSQL/Redis tests, an isolated schema upgrade test, builds, standalone worker runtime tests and browser regressions. Never point these commands at live data. Stop other worker/web/API previews before verification. Worker tests remove only their UUID-named test queues, not the Redis database.

`pnpm test:migrations` creates a uniquely named local `kinto_test_migration_*` database, applies the previous foundation migration, inserts two synthetic tenants/events, upgrades, bootstraps roles, checks backfill/isolation and replays migrations. It drops only that generated database afterward. This verifies a schema upgrade; it is **not** backup/restore evidence. If interrupted, inspect and remove only the generated fixture database after confirming no test is running.

The second migration is transactional and additive. A deployment pipeline must run migrations and role provisioning successfully before starting the new runtime. On failure, stop the rollout and retain the last compatible app version; do not force-resolve an unexplained failed migration or automatically reverse data changes. Local startup remains operator-controlled rather than a production deployment pipeline.

## Proposed staging deployment — approval required

Use isolated staging identities, network, database, Redis, private object storage, email capture and OIDC tenant. The hosting vendor/region/budget remain undecided. Place the website behind TLS and route `/api/v1` to the private API. The worker has no inbound public listener. PostgreSQL, Redis and object storage are private; require authenticated encrypted service connections and deny public access.

Build the pinned release once after verification; record its commit/image digests. Inject narrowly scoped secrets from the chosen secret manager. Run migrations as a short-lived operator job, provision/review function ownership and grants, then deploy compatible API/worker/web revisions. Smoke-test readiness, worker heartbeat, two-tenant isolation and OIDC once implemented before opening access. A failed gate stops rollout. No default credentials or public setup bypass is permitted.

For monitoring, collect sanitized structured logs, request IDs, API readiness/latency/error rate, worker heartbeat/due age/dead count, PostgreSQL capacity/connection errors and Redis memory/evictions. Assign alert recipients and test delivery. Neither alerting infrastructure nor staging smoke evidence exists yet.

For recovery, approve RPO/RTO and retention with the operator, enable encrypted PostgreSQL backups/PITR and private object versioning, and store backups under credentials separate from runtime services. Restore into an isolated environment with outbound email, connector ingestion, payroll schedules and workers disabled. Restore schema/data, roles/grants/RLS, audit/outbox/delivery/receipt history and matching object versions; never restore a queue alone and infer business completion. Verify two synthetic tenants, files, row policies and receipt deduplication before selectively resuming workers. Record timestamps, backup identifiers, checksums, measured loss/recovery time and reviewer sign-off. **This recovery drill and file-storage setup are still outstanding.**

No customer data, public deployment, paid infrastructure or production security approval is authorized by this guide.

## References

- [BullMQ retry behavior](https://docs.bullmq.io/guide/retrying-failing-jobs), [connection behavior](https://docs.bullmq.io/guide/connections), and [job IDs](https://docs.bullmq.io/guide/jobs/job-ids) informed the queue setup. Database receipts remain necessary after queue job removal.
- [Worker implementation evidence](../evidence/phase-01/worker.md) records executed checks and remaining gates.
