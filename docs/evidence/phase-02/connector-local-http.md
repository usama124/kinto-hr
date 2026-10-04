# Protected local connector HTTP — 4 October 2026

## Scope

Adds opt-in synthetic HTTP enrollment, metadata/revocation and heartbeat authentication using the existing independent Redis admission boundary. AppModule registers the controllers and service, but `CONNECTOR_HTTP_MODE=disabled` is the default and their commands return 404 without starting admission dependencies. Only `local_test` is supported; when opted in, production startup, a non-loopback API bind, non-synthetic/remote PostgreSQL, remote Redis or Redis DB 0/1 are rejected. No production adapter or operational approval is invented.

Heartbeat is a stateless authorization probe. It returns safe heartbeat-only credential metadata, not device compatibility, device last-seen persistence, attendance capability or a trusted K50 connection. Production admission-store lifecycle/restore procedures, rotation, the owner UI, local device service, mappings and durable uploads remain pending. P02-01 is partial; foundation readiness is still not production accepted.

## HTTP boundaries

Synthetic machine routes are under `/api/v1/local-machine/connectors`:

- `POST /redemption`: strict JSON `{token}` containing the issued `ke1_` token. No bearer header is accepted. Returns a newly generated credential once; exact redemption retry is denied. A lost response requires owner metadata inspection and revocation/new enrollment, never credential recovery.
- `POST /heartbeat`: strict empty JSON `{}` and `Authorization: Bearer <kc1_credential>`. Returns `{connector}` with heartbeat-only scope and attendance ingestion unavailable. Tenant, device, connector ID and attendance data cannot be supplied in the body.

Both require an actual loopback socket, reject cookie/origin/forwarding assertions, and apply an atomic Redis limit of 60 requests per address per minute before validating secrets. Forwarding headers cannot supply the address. Redis failure blocks admission; there is no browser-session or SQL-only fallback. Responses use the existing no-store/request-ID headers and safe error filter, with no credentials, tokens or infrastructure errors in failures. Standard API JSON body-size limits remain in effect. This loopback rate limit is an exercise safeguard, not production edge/WAF approval.

Company routes are under `/api/v1/tenants/:tenantId/local-connectors`:

- `GET /enrollment-tokens` and `GET /credentials`: owner/HR safe metadata, bounded keyset pagination.
- `POST /enrollment-tokens`: owner issuance with selected-company session, same-origin CSRF, server-derived recent MFA, strict device/allocation versions and UUID idempotency key.
- `POST /enrollment-tokens/:id/revocation` and `POST /credentials/:id/revocation`: owner-only, fresh MFA and same-origin CSRF; strict `{expectedVersion:1}`. Revocation passes through external token seals/tombstones before SQL. Terminal retries retain one audit mutation.

PostgreSQL remains the permission and capacity authority; machine credentials cannot authenticate owner routes. Existing public preparatory enrollment routes and allocation contracts are unchanged. Their unbound tokens are not redeemable by the local authority. The new owner routes explicitly issue generation-bound tokens. All admission state/restore guarantees and lost-response behavior from [internal credential evidence](connector-machine-credentials.md) still apply. The Redis namespace must remain stable across local API restarts; individual seal eviction or restoring admission state alongside SQL is unsafe.

## Optional local exercise

Leave the mode disabled for normal operation. For an authorized synthetic exercise only, apply migrations/bootstrap and configure the commented `.env.example` settings: `CONNECTOR_HTTP_MODE=local_test`, a dedicated loopback Redis DB 2–15, a stable UUID `CONNECTOR_NAMESPACE`, `API_HOST=127.0.0.1`, a local `kinto_test*` database and non-production NODE_ENV. Restart the API with those settings loaded using the repository's normal environment loader. Company commands require the existing selected-company OIDC owner/HR session; there is no demo login or bypass.

An authorized owner uses the new company issuance route, then a local client redeems the token and uses the returned credential for heartbeat. Keep bearer values in memory or protected local test storage, never URLs, browser storage, logs or shell history. The owner can inspect and revoke records through the new company routes. There is no connector UI or installer yet. If the separate Redis admission store fails, readiness fails when this mode is enabled; startup failure cleans up the partial connection. Disabled mode adds no dependency to readiness.

## Verification

Completed local checks:

- `pnpm verify`: 239 unit/API tests across 34 files; formatting, lint, type checks, coverage thresholds, 10 planning documents/187 links and readiness-manifest integrity passed. Coverage: 97.72% statements, 94.04% branches, 100% functions, 98.06% lines. The new configuration gate is included in coverage.
- `pnpm test:integration`: all 229 tests across 20 files passed, including the real HTTP lifecycle in the existing device suite.
- `pnpm test:schema-isolation`: exact classification/forced RLS for 47 business tables passed; no schema/migration/grant changes in this increment.
- `pnpm test:recovery`: the existing 53-migration synthetic restore drill passed; external revocation still denies restored active credentials and consumed-token replay. Private report: `.local/recovery/3aaa6cedca1143618ef1cd6a00974f09/report.json`.

- `pnpm build`: API/web/worker builds passed.
- `pnpm test:worker:runtime`: all four built worker/monitor startup/shutdown checks passed.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 118 desktop/mobile regressions passed, including two new default-disabled machine/owner route checks against the real built API.
- `git diff --check`: passed.

Provider/hardware/remote CI/staging/production acceptance are not claimed.

New HTTP tests cover route separation, safe errors, browser/proxy assertion rejection, strict bearer/body contracts, disabled/rate-limit denial, selected company, CSRF and MFA derivation. The existing device integration suite adds a real HTTP issue → redeem → heartbeat → HR denied revocation → owner revocation journey, including denial after Redis disconnection. No mock is used for credential SQL or admission state in this integration journey. Configuration and service lifecycle tests cover disabled startup, invalid deployment settings, dependency cleanup and rate-limit/store failures.
