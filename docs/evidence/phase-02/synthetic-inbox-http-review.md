# Synthetic inbox review HTTP — 10 October 2026

## Scope and safety

Read-only routes now expose the existing synthetic review functions through the local-test connector gate. `CONNECTOR_HTTP_MODE=disabled` remains the default: reads return 404 and no inbox/admission connections start. Enabled mode requires non-production loopback configuration and a synthetic `kinto_test` database (optionally suffixed with letters, digits or underscores). Production access, machine uploads, reprocessing and attendance/payroll effects remain unavailable. No schema migration or machine permission is added.

## Routes

Under `/api/v1/tenants/:tenantId/local-connectors/devices/:deviceId/synthetic-inbox`:

- `GET /`: strict `limit` (default 25, maximum 50) and optional UUID `afterId` keyset cursor.
- `GET /:eventId/mapping-preview`: required explicit offset-aware `at` instant. No caller source employee, identity, MFA or employee override is accepted.

Both require the existing browser session and selected company, address rate limit and server-derived MFA freshness (no more than five minutes, not future-dated). SQL independently verifies active identity/company/membership and owner/HR permission. A bearer credential alone cannot authenticate review. Responses and errors inherit global no-store and safe exception handling. GET requests do not mutate state and do not require command CSRF tokens; no POST upload/approval/reprocessing route exists.

Review stays bounded to one device, including retired history. Previews use persisted source strings and complete mapping history. Explicit preview times are operator-supplied and unverified; `sourceIdentityVerified`, `clockVerified` and `attendanceProcessingAvailable` remain false even when a mapping matches. Quarantine cannot be cleared through these routes.

## Lifecycle

The existing opt-in service owns the inbox database alongside the local machine authority. Enabled startup checks both dependencies before publishing resources; failed startup closes both without exposing private dependency errors. Readiness checks both stores. Shutdown clears references before disconnecting, and repeated shutdown is inert; subsequent reads return 503. Disabled mode is dependency-free.

## Verification

- `pnpm verify`: formatting, lint, TypeScript, 324 unit/API tests in 38 files, documentation links and readiness manifest validation passed. Coverage: 97.84% statements, 94.15% branches, 100% functions, 98.17% lines (configured coverage scope, not a claim of whole-product coverage).
- `pnpm test:integration`: 262 tests in 20 files passed. The new real SQL/HTTP case verifies owner/HR reads, employee/foreign/revoked authority denial, stale MFA, selected-company mismatch, unknown event isolation, no-store, post-shutdown denial and unchanged raw/audit/outbox state.
- Controller tests cover strict query limits/overrides, missing or offset-free preview times, bearer-only denial, default-disabled behavior, revoked sessions, rate limits and stale/future MFA. Service tests cover review dependency startup failure, readiness loss, cleanup and repeat shutdown.
- `pnpm build`: API, web and worker production artifacts built successfully.
- No schema changes; migration/schema-isolation/recovery drills were not rerun. No UI, identity-provider or worker processing changes; browser/provider/built-worker runtime checks were not rerun. Production acceptance remains false.

Tests use synthetic tenants, records and loopback stores, not a physical K50 or production identity provider.

## Remaining work

Next: owner/HR synthetic review workspace with strict response parsing and selected-device/company isolation. Live upload still requires actual K50 source/reset/clock proof, approved runtime/OS-protected credentials, production admission lifecycle/rotation, mapping reprocessing and finalized-period safety. P02-01/P02-02 and production acceptance remain partial.
