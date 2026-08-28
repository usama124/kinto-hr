# Foundation implementation evidence

Date: 28 August 2026. Scope: local P00-04 architecture spike and partial P01-01 foundation. **Not phase completion, staging approval or production readiness.**

## Delivered

- pnpm workspace with Next.js UI, NestJS API, shared TypeScript contracts/domain rules and Prisma/PostgreSQL persistence.
- Responsive overview, build roadmap and connection guide. Readiness reflects the API/database response; loading, failed response and retry states are implemented. No fabricated employee or payroll totals.
- Public liveness/readiness only, safe HTTP errors, request IDs and security headers. No login bypass or business HTTP routes.
- First migration creates tenants, employee drafts, audit and outbox records with forced row-level security. Local bootstrap creates a separate restricted runtime role; application startup rejects privileged/owner roles.
- Internal draft creation and activation spike with tenant-scoped transactions, optimistic version checks, serialized capacity allocation and atomic audit/outbox persistence. This is not the complete employee lifecycle or subscription service.
- Locked dependencies and database image; formatting, lint, typecheck, unit/API, real PostgreSQL and production-browser checks in GitHub Actions. Branch protection is not configured by this change.

## Environment and executed checks

Local Linux; Node 22.23.2; pnpm 10.28.2; PostgreSQL 16 from the digest in `infra/compose.yaml`. Only synthetic data in a dedicated local `kinto_test` database. Network/port and Prisma cache restrictions required running verification with the environment's explicit elevated permission.

Executed from the repository root with the example local settings exported:

```bash
pnpm install --frozen-lockfile
docker compose --env-file .env -f infra/compose.yaml -p kinto-hr up -d --wait
pnpm db:generate
pnpm db:migrate
pnpm db:bootstrap
pnpm verify:full
pnpm db:migrate
pnpm audit --audit-level=high
```

Installation and frozen-lockfile verification are separate from ordinary lockfile updates. Browser setup uses `pnpm exec playwright install chromium`; this machine stores browser binaries in `/tmp/kinto-playwright`. CI installs Chromium and its system dependencies itself.

Local results:

- Formatting, ESLint with zero warnings, root/web TypeScript and document-link validation passed.
- Unit/API: **31 passed** across four files. Coverage for the selected domain/contracts/configuration files: 100% statements, branches, functions and lines. This is not whole-application coverage; thresholds are 90/85/90/90.
- Real PostgreSQL integration: **10 passed**, including missing tenant context, forced policies, cross-tenant reads/writes, reused pooled connections after rollback, concurrent last-seat allocation, event-write rollback, stale/repeated activation, suspension and restricted runtime privileges.
- Production API and Next.js build passed. Desktop/mobile Chromium suite: **8 passed** for real readiness, responsive layout, navigation, service failure/retry and invalid health payloads.
- Standalone production startup and in-app browser visual review passed at desktop and 360-pixel mobile widths. The overview displayed real connected status; text/cards fit without horizontal overflow. No warning/error entries were reported in the inspected preview tab. This is a local visual check, not an accessibility certification.
- Migration applied to the initially empty database; replay reported no pending migrations. This is the first schema; no previous released schema exists. Backup/restore has not been tested.
- Dependency audit reported **no known vulnerabilities** after the narrow `deepmerge-ts` override. Registry results are time-dependent; CI reruns the audit.

The live GitHub run status must be checked separately after pushing. Local results do not assert remote CI success.

## Defects found during implementation

- PostgreSQL advisory-lock result needed a text cast for Prisma's result decoder. The real concurrency test exercises the corrected query.
- The API prefix needed a leading slash for consistent unknown-route JSON handling in this NestJS/Express version. API tests verify missing/disabled routes remain closed.
- Standalone API startup revealed a missing explicit runtime `@prisma/client` dependency. It was added to the API package. Browser tests now start the built API directly with an empty `NODE_PATH` so inherited package-manager lookup paths cannot hide this regression.
- Readiness fetch now times out rather than leaving the UI indefinitely checking; cancellation on unmount is handled separately from service failure.
- Prisma configuration tooling included a vulnerable merge dependency. A narrow patched override was installed; generation and migration replay were rechecked. See the [decision record](../../implementation/DECISIONS.md).

## Remaining gates and next slice

At the time of this initial slice, outbox writes had no dispatcher/consumer. The subsequent [worker increment](worker.md) adds restricted dispatch, durable processing and local operating instructions. Complete remaining recovery/operating evidence and P01-02 OIDC/MFA, secure sessions, membership resolution, invitations and scoped authorization before exposing employee data. Employee activation still needs the specified organization and employment fields. Draft capacity fields do not constitute immutable plans, complimentary grants or paid subscriptions.

No K50 communication, fingerprint collection, payroll calculation, subscription collection, paid hosting, real customer data, security sign-off, recovery exercise or public deployment occurred. Hardware/firmware access, payroll specialist fixtures and hosting/privacy/commercial decisions remain open. The developer preview must not be used for live HR/payroll records.

Tests reduce regression risk; they cannot guarantee that functionality will never break. Add a focused regression for each defect and keep CI checks required before merging.
