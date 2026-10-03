# Durable provider logout inbox

Local increment on 3 October 2026, based on merged main `56a99df` (PR 55). This implements accepted-event durability and reconciliation, not provider delivery guarantees or production acceptance.

## Delivered

Opt into `AUTH_LOGOUT_MODE=durable` after migration/bootstrap. The default remains `synchronous`; every API instance serving the same authentication namespace must use the same mode. Existing JWT signature/issuer/audience/age/event validation precedes all persistence.

Migration 47 adds `auth_provider_logout_events`, a forced-RLS global control-plane table. It stores only namespace/event/target digests, target kind, signed issue time and acceptance/attempt/completion timestamps. It stores no Logout Token, raw issuer/subject/session ID, password, identity role, company scope or provider credential. Exact namespace/event replay is immutable; changed metadata conflicts. The trusted API has only constrained function execution; direct runtime table access and worker/dispatcher execution are denied. As with existing provider reconciliation functions, JWT verification is the trusted API's responsibility, not performed by SQL.

The callback acknowledges 204 only after PostgreSQL commits the verified receipt. Failure to record it returns generic 503; invalid tokens or changed replay metadata return 401. Cleanup is asynchronous. Login and every authenticated session access check pending **and completed** receipts before existing identity/company authorization, so a failed Redis cleanup cannot restore access. A lookup outage denies with 503. Company memberships and local identity status are unchanged.

Session-ID logout targets that provider session; if both identifiers are signed, session ID takes precedence instead of logging out every session for the subject. Subject-only logout covers that identity in the configured auth namespace. This follows the target distinction in [OpenID Connect Back-Channel Logout actions](https://openid.net/specs/openid-connect-backchannel-1_0.html#BCLogoutActions). Targets are limited to authentication times at or before the signed event issue time. This covers delayed callbacks and prevents cleanup/replay from deleting genuinely newer authentication. Same-second authentication is conservatively denied; clocks must be synchronized.

## Retry and restart

Each API process reconciles on startup and every five seconds, with one pass in flight per process and at most 25 receipts per pass. Atomic least-recently-attempted selection with row locks prevents persistent failures from monopolizing every batch. Different processes may retry the same receipt; cutoff-aware cleanup and coalesced completion are idempotent. No in-memory queue or Redis replay receipt is authoritative.

Redis validates all candidate session metadata before any deletion because Lua command errors do not roll back earlier writes. A target exceeding 1,000 indexed sessions or containing malformed metadata remains pending for operator investigation; access is still denied by the database receipt. No cleanup completion is recorded until Redis succeeds. If the API stops after cleanup but before database completion, startup safely retries. Redis connection recovery can require restarting the API under its existing no-reconnect policy.

Digests remain linkable security metadata, not claimed anonymization. Receipts are retained without automatic purge pending an approved security/privacy retention decision. This increment does not introduce a permanent disabled-identity mirror or an administrator deletion endpoint.

## Verification

- `pnpm verify`: formatting, lint, types, coverage thresholds and **183 unit/API tests** passed.
- `pnpm test:integration`: **186 tests in 19 files** passed, including PostgreSQL refusal, signed-event persistence, Redis/completion outages, API restart, concurrent/exact/conflicting replay, newer authentication, fair batches, namespace privacy and malformed/oversized Redis targets.
- `pnpm test:schema-isolation`: **42 business tables** passed exact classification/policy/grant checks.
- `pnpm test:migrations`: **47 migrations** passed isolated baseline upgrade, restricted bootstrap, replay and isolation checks.
- `pnpm test:recovery`: pending/completed logout receipts and existing business snapshots survived synthetic restore. Private report: `.local/recovery/230bdd4bd1524727a529da9d025876a1/report.json` (ignored). Authentication Redis sessions are never restored with business backups.
- `pnpm build`: API, web and worker passed.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: **84 desktop/mobile scenarios** passed in the default synchronous mode.
- `pnpm test:keycloak`: **12 real local scenarios** passed with durable logout and provider identity-status checks enabled, including completion of the actual signed reset callback. Private report: `.local/keycloak/run-cwzvYH/report.json` (ignored).

No remote CI, delivered production alerts, deployed backup/PITR/file recovery or full production acceptance is claimed.

## Remaining gates and rollout

Apply migration 47, generate Prisma, bootstrap restricted roles and deploy matching API code before enabling durable mode. Keep existing sessions; their signed authentication times and indexes already exist. Validate synthetic restart/outage/replay behavior before configuring every deployed API instance consistently. Reverting to synchronous mode removes persistent revocation enforcement; do not use it as an access-recovery shortcut. Do not drop inbox data during rollback.

Only callbacks that reach Kinto and are verified/committed are recoverable here. A request lost while the entire API/database is unavailable remains the provider's delivery problem; Kinto cannot pull an absent Logout Token from this inbox. Provider retry/availability policy, backlog age/error monitoring and delivered alerts, production database/Redis recovery, consistent deployment, security review and human staging acceptance remain open. Password-reset sign-out choice and fresh provider disable checks remain separate contracts. No live provider, customer or paid infrastructure was modified.

Next bounded local step: private backlog/reconciliation health monitoring and synthetic alert/failure checks, followed by approved staging operations. No full Phase 1 acceptance is claimed.

## Subsequent monitoring increment

The [private health command](provider-logout-monitoring.md) now provides read-only backlog counts/age, stalled-attempt alerts and redacted dependency diagnostics. Deployed scheduling, notification delivery and provider callback availability remain separate gates.
