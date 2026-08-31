# Provider session-revocation evidence

Date: 29 August 2026. Scope: bounded local P01-02 OIDC back-channel and Keycloak reset-path verification, not production recovery approval.

## Delivered

- `POST /api/v1/auth/backchannel-logout` accepts the standard form `logout_token` only while OIDC authentication is enabled. It verifies RS256 against the exact discovered JWKS URL using pinned `jose` 6.2.10.
- Validation requires exact issuer/audience, an `iat` no older than two minutes, bounded unique `jti`, the standard back-channel event, no nonce, and at least one signed subject or provider session ID. Wrong issuer/audience/event, stale/forged/malformed tokens and prohibited nonce fail with the generic response.
- OIDC login retains only the provider session ID in the server session. Redis subject/session indexes use digests; no provider token, password, role or tenant permission is stored. Session rotation, explicit logout and absolute-expiry handling remove index references.
- One Redis Lua operation consumes a logout replay ID and deletes all matching Kinto sessions. Duplicate delivery is idempotent. Subject tokens revoke every indexed session for the identity; session-ID tokens revoke only that provider session.
- The authentication namespace moved to v2. This is an intentional rollout logout because sessions created before the indexes cannot be safely targeted.
- The synthetic Keycloak client registers an exact loopback back-channel URL and requires logout session IDs. The real reset workflow explicitly selects “Sign out from other devices”; password reset then sends a signed Logout Token and invalidates a Kinto session created before reset.

## Verification

The PostgreSQL/Redis/OIDC integration suite passed 65 tests. Added coverage creates two Kinto sessions for one provider session and another for a different provider session, verifies targeted and subject-wide deletion, replays the same event, and rejects wrong algorithm, audience, issuer, nonce, past/future age, event, signature, missing target, oversized and malformed input without deleting the active session.

The pinned Keycloak 26.7.2 workflow passed all 8 real-browser scenarios with the sign-out-other-devices option explicitly selected. Its recovery scenario establishes an independent Kinto session before requesting reset mail, changes the password, waits for the signed back-channel callback, and proves the old Redis session is gone. Password/TOTP, downgrade, unknown-user, generic response, token replay/expiry and revoked-membership assertions remain intact.

`pnpm verify:full` passed locally before the final two negative cases; the current integration suite then passed all 65 cases. The full run covered 61 unit/API/monitoring tests with 100% selected coverage, clean migration upgrade/replay and two-tenant isolation, the synthetic recovery drill, all production builds, 4 built-worker runtime tests, 12 desktop/mobile browser tests, and all 8 real-provider scenarios. The private ignored provider report is `.local/keycloak/run-ia8OP4/report.json`. `pnpm audit --audit-level=high` reported no known vulnerabilities. Remote GitHub Actions and production provider review remain unverified.

## Deliberate limitations and next step

Keycloak exposes “Sign out from other devices” as an unchecked user choice. The locally verified path revokes sessions only after it is selected. Production must explicitly preserve that choice or enforce revocation with a separately reviewed provider extension.

Back-channel delivery is synchronous. There is no durable provider-event inbox, callback retry controlled by Kinto, reconciliation job, or identity-disable synchronization. If Kinto is unavailable during the provider callback, a Kinto session can remain valid until idle/absolute expiry. Recovery therefore remains disabled for live use until the operator approves availability, alerting/reconciliation and the reset policy. Authentication audit, incident-wide revocation, production Redis/JWKS rotation and MFA recovery also remain gates.

Subsequent increments locally verify [administrator-only company-owner setup](owner-invitations.md), [employee activation](employee-account-activation.md) and [owner membership administration with last-owner protection](membership-administration.md). Administrator invitations, tenant selection and customer security audit remain next. No signup or employee business endpoint was added. See [authentication operations](../../operations/authentication.md) and the [roadmap](../../implementation/README.md).
