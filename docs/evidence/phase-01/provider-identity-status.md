# Provider identity status enforcement

Local engineering increment on 3 October 2026, starting from merged main `2ddffa5` (PR 54). This is the first bounded provider identity-disable synchronization slice, not a persistent identity mirror, provider event inbox or production approval.

## Authority and scope

The Keycloak provider controls whether its exact issuer/subject is enabled. Kinto's local identity, membership, employee lifecycle and company status continue to control application access independently. A company-specific revocation never changes a shared global provider account. An enabled provider account cannot restore a disabled local identity, revoked membership, suspended company or terminated employee's company access.

With `IDENTITY_STATUS_MODE=keycloak`, login checks the signed OIDC principal before resolving/activating its local identity. Every authenticated session access also checks its server-stored principal before tenant discovery or business authorization. The adapter uses a dedicated read-only service account: token POST and exact-subject user GET only; it has no provider mutation method, email matching or caller-supplied identity endpoint. Realm, HTTPS/local-test and trusted-MFA configuration reuse the reviewed provisioning validator, but provisioning can remain disabled and uses separate credentials.

The adapter reads the exact user ID and boolean `enabled` from the [Keycloak Admin REST API user representation](https://www.keycloak.org/docs-api/latest/rest-api/index.html#_users). Additional provider fields never reach the browser. There are no database schema, grants or membership changes.

## Outcomes and failure behavior

- Confirmed `enabled=false`: deny with 401 and atomically revoke this issuer/subject's existing sessions in the current Kinto auth namespace, across its company selections. Other identities and issuers are untouched. Revocation failures deny with 503 and can be retried; never grant access.
- Valid exact `enabled=true`: continue existing local identity and company authorization checks. No automatic reactivation or restoration of deleted sessions. A newly authenticated session still requires the existing local access checks.
- Token/user outage, timeout, permissions failure, 404, redirects, mismatched subject or malformed response: unconfirmed state; deny with generic 503, preserve the existing session for a subsequent verified retry and do not alter local/provider account state. A consumed login transaction must restart login after an outage.
- Disabled mode: existing behavior is unchanged. It is the default in `.env.example` and does not require management credentials.

There is no positive-status cache or automatic retry loop. Each checked request performs a token request and a user lookup with five-second per-call deadlines and redirects forbidden. Provider outages therefore make protected access unavailable while the mode is enabled. Operations must review capacity, latency and service-account permissions before enabling it. Readiness probes management authentication only; exact-user read permission is proved by the staging exercise, not that probe. Already authorized in-flight requests are not rolled back if a later observation detects disablement.

## Rollout and remaining work

Use only synthetic accounts until staging/privacy/provider approval. Configure `KEYCLOAK_IDENTITY_STATUS_CLIENT_ID` and `KEYCLOAK_IDENTITY_STATUS_CLIENT_SECRET` for a separate read-only account. Verify enabled/disabled behavior, inability to update users, outage refusal, recovery, shared-identity company revocation and alert routing. Reverting to disabled mode removes this extra provider check; existing local disable/membership boundaries remain but provider-only disable is no longer freshly enforced. Do not use disabling the guard as a customer-access recovery shortcut.

No durable provider observation/audit record, background scan, logout-event reconciliation or local `identities.status` synchronization is delivered here. Existing signed back-channel logout remains separate. Production failure monitoring, bounded persistent reconciliation and deployed security/human acceptance remain open; no completed Phase 1 acceptance is claimed.

## Verification

- `pnpm verify`: formatting, lint, type checks, coverage thresholds and **183 unit/API tests** passed.
- `pnpm test:integration`: **181 tests in 19 files** passed, including provider disable, issuer/subject isolation, generic outage and failed-revocation denial/retry, management-auth readiness failure and shared-identity company revocation.
- `pnpm test:schema-isolation`: all **41 business tables** passed; no migration, policy or grant changes.
- `pnpm build`: API, web and worker passed.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: **84 desktop/mobile scenarios** passed with the default-disabled mode.
- `pnpm test:keycloak`: **11 real local scenarios** passed with the status guard enabled. A separate reader token could fetch the exact account but its update was forbidden; provider disable revoked the Kinto session and re-enable did not restore it. Private report: `.local/keycloak/run-1EVzeZ/report.json` (ignored).

The real-provider fixture uses generated disposable credentials and removes its realm/secret fixtures. No live account or deployment is modified. Migration/recovery/worker-runtime suites are not rerun in this increment because persistence and workers are unchanged; their CI steps remain intact. No remote CI or production acceptance is claimed.
