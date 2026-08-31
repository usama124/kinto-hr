# Kinto HR

An HR SaaS for Pakistan: employee management, ZKTeco K50 attendance and payroll, delivered in verified phases.

**Current release: foundation development preview. Not a production HR system.**

## What exists

- Responsive Next.js workspace, implementation roadmap and connection guide.
- NestJS liveness/readiness endpoints with safe errors, security headers and a runtime-database-role check.
- TypeScript contracts and initial permission/capacity invariants.
- PostgreSQL/Prisma migration with forced row-level security and a separate restricted application role.
- Internal employee draft/activation persistence primitives with serialized capacity allocation, transactional audit and durable outbox writes.
- Separate BullMQ/Redis worker with durable delivery state, tenant-scoped processing, duplicate receipts prevented, bounded retries and audited local replay.
- Expiring worker heartbeats, private operational health/Prometheus metrics, and a repeatable synthetic PostgreSQL backup/restore drill.
- Identity/membership persistence and an internal permission/MFA boundary with immediate rechecks of revoked access.
- Optional OIDC login/callback, Redis server sessions, CSRF-protected logout and signed OIDC back-channel revocation. A pinned Keycloak LoA 2 profile and real browser/TOTP/email/reset-revocation fixture are locally verified; authentication remains disabled by default.
- Separate platform-operator authority, guarded first-operator bootstrap, and an MFA/CSRF-protected idempotent company request with optional Keycloak initial-owner reconciliation, expiring setup delivery and atomic first-owner activation.
- Tenant-scoped owner/HR employee-account requests with recent MFA, idempotent provider setup delivery and exact-identity activation into one fixed employee membership/link.
- Unit/API, real PostgreSQL and desktop/mobile browser regression suites; coverage gates and GitHub Actions CI.
- The complete [implementation roadmap](docs/implementation/README.md) and six phase specifications.

The employee persistence primitives are a foundation spike, not the complete employee lifecycle. The only employee-scoped HTTP mutation requests login access for an existing employee; it does not expose employee CRUD. When the separately configured Keycloak adapter succeeds, only the exact reconciled identity completing trusted MFA can atomically receive the fixed employee membership and durable employee link. The same boundary grants the exact invited first owner for a platform-created company. There is no demo login or authorization bypass. The worker's first consumer only records receipt of committed activation events; business automation is not enabled.

Employee provider delivery/activation, production invitation reconciliation hardening, employee workflows, imports/documents, attendance, payroll, billing and real K50 communication remain future slices. Payroll permission tests assert a future invariant; they do not mean payroll is available. No customer records or biometric templates are included. See [authentication setup and limitations](docs/operations/authentication.md) and [Keycloak verification](docs/operations/keycloak.md).

Required account access: only platform admins create companies and initial owners; only company admins/authorized HR request employee accounts within their company. Neither companies nor employees can self-register, including on Free plans. With provisioning disabled, login accepts existing identities only. The optional reviewed Keycloak path creates or exactly reconciles an approved owner/employee, sends provider-managed setup actions, and grants only the intended first-owner or fixed employee membership after exact-subject trusted MFA. Provider password reset with sign-out-other-devices selected revokes indexed Kinto sessions locally; production delivery/recovery/outage approval is still pending. See [account provisioning requirements](docs/implementation/DECISIONS.md).

## Local development

Requires Node.js **22.23.2** (see `.nvmrc`), pnpm **10.28.2**, and Docker Compose. PostgreSQL and Redis images are pinned by digest. Install pnpm using `npm install --global pnpm@10.28.2` if needed.

From the repository root, in a Bash-compatible shell:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
set -a
. ./.env
set +a
docker compose --env-file .env -f infra/compose.yaml -p kinto-hr up -d --wait
pnpm db:generate
pnpm db:migrate
pnpm db:bootstrap
pnpm dev
```

Open [the local workspace](http://127.0.0.1:3000). The API listens on `127.0.0.1:4000`; PostgreSQL and Redis bind only to localhost ports `55432` and `56379` by default. The web application proxies only the public health endpoints. `API_URL` is a trusted operator setting and must be set before building because Next.js records rewrites at build time. Existing installations must add the worker variables from `.env.example` without overwriting their `.env`; see the [operating guide](docs/operations/foundation.md).

The example passwords are **local development fixtures only**. Never deploy them. Do not overwrite an existing `.env`. The bootstrap script refuses non-local/non-`kinto_*` targets and is not a production provisioning tool. Migration credentials must never be used by the running API; startup rejects unsafe roles. The database initially has no employee records; tests create and remove their own synthetic tenants.

To stop the local database without deleting data:

```bash
docker compose --env-file .env -f infra/compose.yaml -p kinto-hr stop
```

## Verification

Keep the test database running and export the `.env` settings as above. Stop any manually started web/API servers before the browser suite; it deliberately refuses to reuse unknown processes on its ports.

```bash
pnpm verify
pnpm test:integration
pnpm test:migrations
pnpm test:recovery
pnpm db:migrate
pnpm build
pnpm test:worker:runtime
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:keycloak
```

`pnpm verify:full` combines the checks, database/Redis tests, isolated migration/restore drills, builds, worker/monitor runtime tests and browser suite after dependencies/services/browser setup. `pnpm verify` includes formatting, lint, TypeScript, unit/API coverage and planning-document links. Integration tests require explicit `kinto_test*` URLs and fail rather than silently skip when services are unavailable. Migration/recovery verification creates and removes only its own generated local test databases. Recovery uses PostgreSQL tools inside `RECOVERY_POSTGRES_CONTAINER` (default `kinto-hr-postgres-1`) and verifies that it matches the local database cluster. Never point tests at production.

The integration suite covers missing context, cross-tenant reads/writes, pooled transactions/rollback, competing final-seat activations, event-write failure, stale activation, suspended tenants, runtime-role safety and immutable audit permissions. Browser tests cover real readiness, route navigation, mobile overflow, error/retry and invalid health responses. Test evidence is uploaded by CI.

Worker integration tests cover rollback of partial effects, duplicate delivery, restricted dispatcher/worker permissions, company isolation/concurrency, retry/dead-letter handling, audited replay and recovery of a missing Redis job. The built worker is tested without inherited module lookup paths, including startup failure and graceful shutdown.

With a worker running, `pnpm worker:check` reports operational alerts and exits nonzero for missing workers, dependency failure, dead deliveries or work at least five minutes overdue. After a build, `pnpm worker:monitor` exposes `/metrics` and `/health/ready` only on `127.0.0.1:9464`. It is not a public customer API. See the [operating guide](docs/operations/foundation.md) for thresholds, recovery boundaries and remaining staging gates.

Coverage gates apply to the implemented contracts, domain rules and API/worker configuration: 90% statements/functions/lines and 85% branches. Database behavior is verified against PostgreSQL, not counted as mock-based coverage. Extend existing suites with a regression case whenever a defect is fixed. No finite suite guarantees a bug-free product.

## GitHub workflow

Work on `codex/*` branches and review before merging. The `CI / Verify foundation` job runs on pushes and pull requests, including migration replay and desktop/mobile browser checks. **Configure this status as required on `main` in GitHub branch protection/rulesets.** A workflow alone does not enforce merge protection; this change does not alter repository settings or bypass review.

Actions and dependencies are pinned. Run `pnpm audit --audit-level=high` when changing dependencies; investigate findings rather than using forced upgrades. Do not commit `.env`, runtime caches, generated clients, browser reports, real payroll data or credentials.

## Structure and next work

- `apps/web`: Next.js preview UI.
- `apps/api`: NestJS health/authentication endpoints, protected company/employee account requests, and safe HTTP boundary.
- `apps/worker`: restricted outbox dispatcher and foundation event consumer.
- `packages/contracts`, `packages/domain`: shared validated contracts and initial business invariants.
- `packages/database`: schema, migration and tenant-scoped persistence.
- `scripts`, `infra`: local setup and validation.
- `tests/integration`, `tests/e2e`: database and browser regressions.
- `docs/implementation`: specification baseline and progress records.
- `docs/operations`: local runbook and proposed staging controls.

Next: continue P01-02 with membership administration, last-owner protection and customer-visible security audit, then scoped company/legal-entity and policy administration before employee CRUD APIs. Initial-owner and employee provider activation are locally verified but still need durable delivery/reconciliation and production approval. Signed provider back-channel revocation is locally verified; identity-disable synchronization and incident-wide revocation remain operational gates. The Keycloak LoA 2 flow remains the only trusted MFA profile. Local database restore and worker monitoring are implemented; scheduled encrypted backups/PITR, private-file recovery, alert notification delivery, staging provisioning and remote CI success remain unverified. Foundation/Phase 1 is not complete: company policies, immutable entitlements and full employee/compensation/import workflows are still pending. Real K50/firmware validation, independently reviewed Pakistan payroll rules, hosting/privacy and commercial approvals remain external release gates. Do not use this preview for live HR/payroll data.
