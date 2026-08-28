# Authentication foundation operations

29 August 2026 · Internal development only. Not approved for live customer data.

## Delivered boundary

`AUTH_MODE=disabled` is the default. All auth endpoints return 404 while disabled. `/login` explains the administrator-only account policy and shows the actual API state. No password form, signup or account-creation endpoint is provided.

When explicitly configured, NestJS exposes `GET /api/v1/auth/login`, `GET /api/v1/auth/callback`, `GET /api/v1/auth/session` and `POST /api/v1/auth/logout`. Next.js proxies only health and auth paths. Login uses the maintained `openid-client` 6.8.7 library, authorization code, S256 PKCE, state, nonce and RS256 signature verification. Provider tokens stay on the server and are discarded after identity validation; refresh tokens are not requested. Discovery, token and JWKS requests have five-second timeouts, reject redirects and remain on the configured issuer origin. Providers that split these endpoints across origins are not supported by this slice.

Login resolves an existing active Kinto identity using the verified issuer/subject and forced PostgreSQL RLS. Unknown/disabled identities are refused; login never inserts identities, memberships or tenants. The session endpoint rechecks that identity. A session is not company authorization: every future business handler must call `inAuthorizedTenant` using the server session's principal and keep all work inside that transaction. Never accept identity, role or MFA data from a header/body/query. Membership revocation and tenant suspension continue to be checked at that business boundary.

**MFA remains unverified:** the adapter always sets `mfaVerified=false`, even if a signed token contains `acr`, `amr` or roles. Consequently privileged company operations remain denied. Real Keycloak MFA claim mapping, recovery and account activation must be implemented and tested before this restriction changes.

## Configuration and provider gate

Keep authentication disabled until a synthetic identity provider and account fixture are explicitly prepared. This slice does not deploy Keycloak or provide an operator/account bootstrap script. Test fixtures create and remove their own synthetic identity records; do not treat those helpers as a customer provisioning workflow or seed real users through migration credentials.

To enable an approved test environment, supply these server-only settings through the environment (never commit secrets):

- `AUTH_MODE=oidc`
- `AUTH_ORIGIN`: exact public web origin, with no path, query, credentials or fragment. Callback is always `${AUTH_ORIGIN}/api/v1/auth/callback`; completion always returns to `/login`. Host/forwarding headers and return URLs cannot override it.
- `OIDC_ISSUER`: exact discovery issuer, without query/fragment/credentials.
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: confidential client credentials. Secret must be at least 16 characters.
- `AUTH_REDIS_URL`: private dedicated authentication Redis database/instance; production configuration requires `rediss:`. Local example uses database 1, separate from worker queues.

HTTPS is required for web/identity URLs. Plain HTTP/Redis is accepted only for loopback addresses with an explicit `NODE_ENV=development` or `test`. Cookies **always** retain Secure, HttpOnly, SameSite=Lax, Path=/ and `__Host-` names. Prefer local HTTPS when exercising a real browser; do not weaken cookies to accommodate plain-HTTP browser behavior. A production build should be tested behind same-origin HTTPS.

Before real-provider acceptance, configure and verify:

- Registration disabled at the identity provider as well as the application; no automatic company membership from email/domain or federated first login. This applies to Free and complimentary tenants too.
- Confidential client with authorization-code flow only, S256 required, RS256 ID tokens and exact callback allowlist; no wildcard redirect, implicit or password grant.
- `auth_time` emitted and `max_age=300` respected; synchronized clocks. Login requires recent authentication. Privileged-action reauthentication is still future work.
- Reset-password and invitation/password-setup flows for existing administrator-provisioned accounts only, single-use expiring tokens, generic responses and mail delivery without secrets in logs. These flows are not tested/delivered here.
- Privileged MFA policy, disabled-account behavior, key rotation, provider outages and account-recovery/session-revocation behavior verified against the actual chosen provider.

The provider configuration cannot be inferred from OIDC discovery. An administrator must verify the registration and grant settings; this adapter cannot prevent a misconfigured external identity provider from creating its own users. Such users still receive no Kinto session unless separately provisioned in Kinto.

## Session storage, logout and failure behavior

Redis stores a ten-minute, single-use login transaction and an opaque server session. Browser handles are random 256-bit values; Redis keys contain their SHA-256 digests and a namespace derived from issuer/client/origin. Session records contain identity reference, verified principal, authentication time, CSRF token and expiry, but no passwords, ID/access/refresh tokens or tenant roles. Redis must remain private and use access controls/TLS before deployment; the local container has no production credentials.

Sessions have a 30-minute idle timeout and 12-hour absolute limit, enforced atomically with Redis time. Login rotates the session and invalidates the previous handle. Concurrent reads cannot recreate a deleted session. Logout requires an exact Origin and session-bound `X-CSRF-Token`; it deletes the server session and clears the cookie. Logout affects this Kinto session only, not other browsers or the provider SSO session. Provider logout/back-channel revocation, all-session revocation on password reset and authentication audit events remain follow-up work.

Authentication endpoints share a 60-requests/minute limit per socket address. Forwarded-IP headers are ignored. Behind a proxy this is a conservative shared limit; add verified edge per-client abuse controls and review trusted-proxy deployment before production. Do not silently trust arbitrary `X-Forwarded-For` values.

Enabled authentication must initialize Redis and discovery successfully or API startup fails. Readiness includes an auth-store ping. Dependency failures deny requests with generic errors; no memory fallback bypasses session checks. The Redis client does not reconnect indefinitely: restart the API after a lost connection. Do not log callback URLs/codes, cookies, token exchanges, CSRF values or secrets at the proxy/provider.

Authentication Redis is disposable security state, not business recovery data. Do not restore old sessions/login transactions from backups; clear only the dedicated auth store or change its namespace under an approved procedure after recovery. Never flush a Redis instance shared with worker queues. A database/business restore must not resurrect old logged-out sessions. Session encryption/secret rotation and incident-wide revocation require deployment review.

## Verification and next work

Run `pnpm verify:full` using the documented local test services. The auth integration suite uses a loopback synthetic OIDC protocol server with actual RSA signatures, discovery/JWKS and PKCE exchange plus real PostgreSQL/Redis. It does not simulate a real Keycloak password/MFA screen or email recovery. Browser tests cover disabled access and explicitly mocked UI states, not a verified provider login journey.

Next: actual Keycloak test realm with registration disabled, tested MFA and recovery; protected first-operator/company-owner provisioning and company-admin/HR employee invitations; membership selection/administration, last-owner protection and security audit. Company/policy administration and employee HTTP APIs remain closed until their authorization/lifecycle requirements are complete. See the [roadmap](../implementation/README.md).
