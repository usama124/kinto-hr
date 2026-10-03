# Private provider logout monitoring

Local engineering increment, 3 October 2026, starting from merged main `395a735` (PR 56). No production scheduling, notification routing or staging acceptance is approved by this record.

## Contract and access

Migration 48 adds `provider_logout_health(text)`: a fixed-search-path security-definer function owned by the existing non-login control owner. Only the trusted API runtime has execute permission; PUBLIC, worker and dispatcher cannot execute it. Direct table access remains denied. The function filters pending receipts to one namespace and returns four aggregates: pending count, unattempted count, oldest acceptance age in seconds, and seconds since the latest attempt among pending receipts (null if none). Completed receipts and other namespaces do not affect these values. PostgreSQL time avoids differences between probe/API host clocks; negative ages are clamped to zero.

The function is read-only. A probe never invokes `pending_provider_logouts`, updates attempt ordering, cleans Redis, completes receipts or affects access. It exposes no event keys, target digests, subject/session identifiers or raw tokens. It is an internal operations boundary, not a tenant-accessible API. The monitor uses restricted API runtime credentials; keep those credentials private and do not give them to a customer or monitoring browser. A dedicated read-only monitor role can be reviewed separately before deployment.

## Command and diagnostics

Apply migration 48 and bootstrap roles, then run `pnpm auth:logout:check` in a private operations environment with the API's `DATABASE_URL` and identical auth settings. It loads the local `.env` if present; explicitly injected environment values take precedence. It uses the same issuer/client ID/canonical origin hash as the API. No HTTP listener or public health route is added. Durable mode is required; disabled or synchronous auth must not appear healthy to this check.

The command emits one JSON report and exits 0 for `ready`, 1 for `unavailable`. When invoking through pnpm, pnpm may add its own script banners; consume the script's JSON line or invoke the installed tsx script directly when machine parsing. Fields are `status`, `alerts`, and `backlog`. Failure reports have null backlog, never misleading zero counters or raw dependency errors.

Alerts:

- `logout_backlog_overdue`: pending acceptance age reaches `AUTH_LOGOUT_MAX_PENDING_SECONDS`, default 300.
- `logout_reconciliation_stalled`: pending acceptance age reaches `AUTH_LOGOUT_MAX_IDLE_SECONDS`, default 30, and no pending receipt has a newer attempt. A recent attempt can clear this alert even while cleanup fails; the oldest-pending alert still detects persistent failure.
- `logout_probe_unavailable`: dependencies, permissions, malformed snapshot or five-second collection timeout. Raw errors/URLs are suppressed.
- `logout_durable_mode_required`: auth is disabled or uses synchronous mode.
- `logout_monitor_configuration_invalid`: invalid auth, database or threshold configuration. Each threshold must be a positive integer no greater than 86,400 seconds.

The command validates a restricted runtime role and bounds collection to five seconds, with at most one additional second for disconnect. It exits even if a connection cannot finish. Successful probes do not inspect Redis contents or change sessions. Existing public readiness remains separate.

## Operations and limitations

Use an approved private scheduler (for example every 15 seconds), alert on nonzero exits and separately detect a missing/stale scheduled result. Do not publish these reports or credentials as public web metrics. A command that never runs cannot alert for itself. Recipients, escalation/suppression policy, alert delivery and production permissions require review.

Investigate Redis connectivity, stopped API reconcilers, malformed session metadata and oversized indexes when backlog alerts persist. Repair dependencies and let normal bounded retries complete the work. Do not delete pending receipts, manually mark them complete, disable durable enforcement or re-enable provider identities to silence an alert.

An empty backlog means no known accepted pending work, not a live reconciler heartbeat or successful provider callback delivery. The command cannot detect Logout Tokens that never reached Kinto, distinguish all per-receipt failure causes, measure completion latency after completion, or approve privacy retention. Aggregation cost scales with pending work in the selected namespace; the collection deadline limits probe duration. Pending/completed receipts retain their existing authorization and retention contract.

## Verification

- `pnpm verify`: formatting, lint, types, coverage thresholds and **187 unit/API tests in 26 files** passed.
- `pnpm test:integration`: **188 tests in 19 files** passed. Monitoring regressions cover real namespace filtering, completed-receipt exclusion, null/elapsed ages, no mutation of receipt timestamps, restricted grants, actual Redis cleanup failure, private command exits and dependency/configuration redaction.
- `pnpm test:schema-isolation`: **42 business tables** passed exact forced-RLS/policy/grant checks.
- `pnpm test:migrations`: **48 migrations** passed isolated baseline upgrade, restricted bootstrap and replay.
- `pnpm test:recovery`: restored monitoring executed under the restricted runtime role, retained its fixed owner/search path/worker denial and did not change restored receipts. Private report: `.local/recovery/ede430dfc1bf453aa7657813d35f7421/report.json` (ignored), with `providerLogoutMonitoringRestored: true`.
- `pnpm build`: API, web and worker production builds passed. The initial sandboxed web build could not parse its TypeScript subprocess output; rerunning with the required subprocess permissions passed.

Unit tests also cover inclusive threshold boundaries, healthy empty/fresh backlogs, malformed aggregates, identifier-safe output projection and hung-probe timeout. Existing CI integration and migration/recovery gates execute the new regressions; no external service is introduced. Browser, worker-runtime and real Keycloak scenarios were not rerun for this private command increment; those existing CI steps remain intact. No remote CI or deployed alert delivery is claimed.

Next local backlog: optional employee bank-detail capture with private recent-MFA authorization and regression coverage. Salary payment remains outside Kinto. Approved storage/scanning, retention, provider availability, alert delivery and staging acceptance remain production gates.
