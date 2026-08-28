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
- Unit/API, real PostgreSQL and desktop/mobile browser regression suites; coverage gates and GitHub Actions CI.
- The complete [implementation roadmap](docs/implementation/README.md) and six phase specifications.

The persistence primitives are a foundation spike, not the complete employee lifecycle. They intentionally have no HTTP endpoints until identity, membership checks, full activation fields and employee permissions are implemented. There is no demo login or authorization bypass. The worker's first consumer only records receipt of committed activation events; business automation is not enabled.

OIDC/MFA, employee workflows, imports/documents, attendance, payroll, billing and real K50 communication remain future slices. Payroll permission tests assert a future invariant; they do not mean payroll is available. No customer records or biometric templates are included.

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
pnpm db:migrate
pnpm build
pnpm worker:check
pnpm test:worker:runtime
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm verify:full` combines the checks, database/Redis tests, isolated migration upgrade test, builds, worker runtime tests and browser suite after dependencies/services/browser setup. `pnpm verify` includes formatting, lint, TypeScript, unit/API coverage and planning-document links. Integration tests require explicit `kinto_test*` URLs and fail rather than silently skip when services are unavailable. Migration verification creates and removes only its own generated local test database. Never point tests at production.

The integration suite covers missing context, cross-tenant reads/writes, pooled transactions/rollback, competing final-seat activations, event-write failure, stale activation, suspended tenants, runtime-role safety and immutable audit permissions. Browser tests cover real readiness, route navigation, mobile overflow, error/retry and invalid health responses. Test evidence is uploaded by CI.

Worker integration tests cover rollback of partial effects, duplicate delivery, restricted dispatcher/worker permissions, company isolation/concurrency, retry/dead-letter handling, audited replay and recovery of a missing Redis job. The built worker is tested without inherited module lookup paths, including startup failure and graceful shutdown.

Coverage gates apply to the implemented contracts, domain rules and API/worker configuration: 90% statements/functions/lines and 85% branches. Database behavior is verified against PostgreSQL, not counted as mock-based coverage. Extend existing suites with a regression case whenever a defect is fixed. No finite suite guarantees a bug-free product.

## GitHub workflow

Work on `codex/*` branches and review before merging. The `CI / Verify foundation` job runs on pushes and pull requests, including migration replay and desktop/mobile browser checks. **Configure this status as required on `main` in GitHub branch protection/rulesets.** A workflow alone does not enforce merge protection; this change does not alter repository settings or bypass review.

Actions and dependencies are pinned. Run `pnpm audit --audit-level=high` when changing dependencies; investigate findings rather than using forced upgrades. Do not commit `.env`, runtime caches, generated clients, browser reports, real payroll data or credentials.

## Structure and next work

- `apps/web`: Next.js preview UI.
- `apps/api`: NestJS health endpoints and safe HTTP boundary.
- `apps/worker`: restricted outbox dispatcher and foundation event consumer.
- `packages/contracts`, `packages/domain`: shared validated contracts and initial business invariants.
- `packages/database`: schema, migration and tenant-scoped persistence.
- `scripts`, `infra`: local setup and validation.
- `tests/integration`, `tests/e2e`: database and browser regressions.
- `docs/implementation`: specification baseline and progress records.
- `docs/operations`: local runbook and proposed staging controls.

Next: complete recovery/operating evidence and P01-02 OIDC sessions and verified memberships before exposing employee APIs. Staging provisioning and remote CI success remain unverified. Real K50/firmware validation, independently reviewed Pakistan payroll rules, hosting/privacy and commercial approvals remain external release gates. The source code in this foundation must not be used to process live HR or payroll data.
