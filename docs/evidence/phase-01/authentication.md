# OIDC and server-session foundation evidence

Date: 29 August 2026. Scope: bounded P01-02 login/session integration, not production identity acceptance or a completed foundation.

## Delivered

- Optional OIDC authorization-code login/callback using pinned `openid-client` 6.8.7. S256 PKCE, state, nonce, RS256 signature, issuer, audience, expiry and recent authentication checks run on the server. Discovery/token/JWKS requests are restricted to the configured issuer origin, with no redirects and bounded timeouts.
- Exact configured callback/return destinations, unaffected by hostile Host/forwarding headers or user return URLs. Registration and business endpoints remain closed.
- Existing active identity lookup under forced RLS; no login-time account, tenant, role or membership provisioning. Disabled identities lose session access on their next check. Login does not restore revoked membership.
- Redis-backed opaque sessions, 256-bit random handles, digested storage keys, single-use ten-minute login transactions, 30-minute idle/12-hour absolute session expiration, login rotation and atomic deletion/touch behavior. No provider tokens, roles or credentials are persisted in the session or browser.
- Secure/HttpOnly/SameSite=Lax host-only cookies, Origin plus CSRF protection on logout, safe session projection, auth readiness and shared per-socket request limits. Redis errors fail closed; no in-memory authentication fallback.
- `/login` account-access page and same-origin auth proxy. UI displays disabled, anonymous, authenticated and failure states and submits CSRF-protected logout. No password/signup form or fake default identity.
- Administrator-only company/employee provisioning rules C11–C12 are retained throughout the plan. No employee APIs were opened and no runtime identity/membership write privileges were granted.

## Verification

`pnpm verify:full` passed locally: **127 tests** — 61 unit/API/monitoring, 50 PostgreSQL/Redis integration, 4 built worker/monitor runtime, and 12 desktop/mobile browser tests. Clean migration/upgrade/replay and the synthetic PostgreSQL recovery drill also passed. No schema migration was required for this increment.

The 21 new auth integration cases use a loopback synthetic OIDC protocol server, actual RSA signatures/JWKS/discovery/PKCE, and real PostgreSQL/Redis. They cover valid login, signature/algorithm/issuer/audience/nonce/expiry/auth-time failures, missing ID token, unknown identity, cookie/state/replay/concurrency boundaries, session rotation/expiry, CSRF/origin checks, disabled identities, preserved membership revocation, registration denial, rate limits and dependency failures. Store-error/readiness response tests inject controlled failures; other token/session operations use the real clients/services.

Browser coverage verifies the built application with auth disabled and explicitly mocked enabled/error/logout UI responses. It is **not** evidence of a real Keycloak browser login, provider MFA, recovery email or browser cookie transport through an HTTPS proxy. The built API starts without inherited module lookup paths; Node 22 loads the pinned OIDC client successfully.

Formatting, lint, TypeScript checks, selected domain/contracts/config coverage gates and API/web/worker production builds passed. The coverage gate is not whole-application/auth coverage; auth protocol behavior is covered by the integration tests. GitHub Actions has not been run remotely by this work.

`pnpm audit --audit-level=high` reported no known vulnerabilities. Added OIDC/Redis clients declare MIT licenses. The final documentation check validated 10 planning documents and 50 local links; `git diff --check` passed. Initial sandbox runs could not bind sockets/reach dependencies; reruns with local-test permissions and the existing containers running passed as recorded above.

Recovery evidence: `.local/recovery/f2c2bc901517490f96b2c790190f3935/report.json` (ignored, synthetic data only). Existing local test containers were restarted for verification. No customer data, live identity provider, external hosting or paid resources were used.

## Deliberate limitations and next step

Authentication stays disabled by default. Real-provider configuration is an explicit prerequisite, not implied by a successful synthetic protocol test. Provider registration must be disabled independently; OIDC discovery does not prove that setting. Kinto nevertheless refuses a session for an unprovisioned identity.

The adapter sets `mfaVerified=false` regardless of provider `acr`, `amr` or role claims. Privileged company operations remain denied until the actual provider's MFA semantics are verified. Session inspection does not grant company access; future business routes must use `inAuthorizedTenant` and its fresh membership/tenant checks.

Subsequent increments added the [real Keycloak MFA/reset workflow](keycloak-mfa.md), [signed provider-session revocation](session-revocation.md), protected company requests, [initial-owner activation](owner-invitations.md) and [employee activation](employee-account-activation.md). Membership selection/administration, last-owner guard and security audit remain next. Production callback reconciliation, Redis controls and edge abuse limits also need acceptance. Then company/policy administration and employee lifecycle APIs. Foundation/Phase 1 remains incomplete.

See [authentication operations](../../operations/authentication.md) and [the roadmap](../../implementation/README.md). The implementation follows the maintained library's [code-flow checks](https://github.com/panva/openid-client/blob/v6.8.7/docs/interfaces/AuthorizationCodeGrantChecks.md) and explicitly enables its [JWT signature checks](https://github.com/panva/openid-client/blob/v6.8.7/docs/functions/enableNonRepudiationChecks.md).
