# Authentication foundation operations

29 August 2026 · Internal development only. Not approved for live customer data.

## Delivered boundary

`AUTH_MODE=disabled` is the default. All auth endpoints return 404 while disabled. `/login` explains the administrator-only account policy and shows the actual API state. No password form, signup or account-creation endpoint is provided.

When explicitly configured, NestJS exposes `GET /api/v1/auth/login`, `GET /api/v1/auth/callback`, `GET /api/v1/auth/session`, `POST /api/v1/auth/logout` and the provider-only `POST /api/v1/auth/backchannel-logout`. Next.js proxies only health and auth paths. Login uses the maintained `openid-client` 6.8.7 library, authorization code, S256 PKCE, state, nonce and RS256 signature verification. Provider tokens stay on the server and are discarded after identity validation; refresh tokens are not requested. Discovery, token and JWKS requests have five-second timeouts, reject redirects and remain on the configured issuer origin. Providers that split these endpoints across origins are not supported by this slice.

Login resolves an existing active Kinto identity using the verified issuer/subject and forced PostgreSQL RLS. Unknown/disabled identities are refused. The sole activation exception is an already reconciled, unexpired initial-owner invitation: exact-subject trusted MFA can atomically create its first owner membership and accept the invitation. Login never creates a tenant or an unapproved provider identity. The session endpoint rechecks the identity. A session is not company authorization: every future business handler must call `inAuthorizedTenant` using the server session's principal and keep all work inside that transaction. Never accept identity, role or MFA data from a header/body/query. Membership revocation and tenant suspension continue to be checked at that business boundary.

MFA is unverified by default: `OIDC_MFA_PROFILE=none` always sets `mfaVerified=false`, even if a signed token contains `acr`, `amr` or roles. The only supported opt-in is the separately reviewed and tested `keycloak-loa2-v1` profile, which requires essential/exact signed `acr=2`; see [Keycloak operations](keycloak.md). This meaning is provider/flow-specific, not universal. Other providers remain untrusted. Company provisioning and employee-account requests additionally require `auth_time` no older than five minutes on every request. Initial-owner activation is available only under the reviewed Keycloak provisioning mode described below. The reviewed Keycloak reset path exercises signed back-channel revocation as described below.

## Configuration and provider gate

Keep authentication and account provisioning disabled until a synthetic identity provider and account fixture are explicitly prepared. This repository does not deploy production Keycloak. Test fixtures create and remove synthetic identities; do not treat those helpers as customer onboarding.

After an approved provider account exists, the first and only first platform operator can be bound explicitly with migration credentials. Set `PLATFORM_BOOTSTRAP_ISSUER` and `PLATFORM_BOOTSTRAP_SUBJECT` to the exact verified provider identifiers, set `PLATFORM_BOOTSTRAP_CONFIRM=bootstrap-first-platform-operator`, and run `pnpm db:bootstrap:operator`. The command records an audit event, is idempotent only for the same active identity and refuses to replace an existing operator. It never creates a provider password. Do not place these values in committed files or use the operation to manage later operators; a separately authorized membership workflow is still required.

To enable an approved test environment, supply these server-only settings through the environment (never commit secrets):

- `AUTH_MODE=oidc`
- `AUTH_ORIGIN`: exact public web origin, with no path, query, credentials or fragment. Callback is always `${AUTH_ORIGIN}/api/v1/auth/callback`; completion always returns to `/login`. Host/forwarding headers and return URLs cannot override it.
- `OIDC_ISSUER`: exact discovery issuer, without query/fragment/credentials.
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: confidential client credentials. Secret must be at least 16 characters.
- `AUTH_REDIS_URL`: private dedicated authentication Redis database/instance; production configuration requires `rediss:`. Local example uses database 1, separate from worker queues.

Initial-owner delivery is a separate opt-in. Set `ACCOUNT_PROVISIONING_MODE=keycloak`, `KEYCLOAK_PROVISIONING_CLIENT_ID` and `KEYCLOAK_PROVISIONING_CLIENT_SECRET` only for the reviewed Keycloak LoA 2 issuer. The client must be a dedicated confidential service account with only the reviewed user-management permissions. Kinto creates the provider user disabled; existing enabled accounts require an exact provider-verified email, while disabled retry reconciliation requires the request marker. Kinto records the provider subject and invitation in PostgreSQL, then enables the account and asks Keycloak to send `VERIFY_EMAIL`, `UPDATE_PASSWORD` and `CONFIGURE_TOTP` actions with a 48-hour lifetime. Kinto stores no action token or password. Provider failure leaves the request pending and creates no membership; an operator may safely replay the same company request.

Employee-account requesting is implemented independently of provider delivery. `POST /api/v1/tenants/{tenantId}/employees/{employeeId}/account-invitations` requires a current server session, exact same-origin CSRF, a UUID idempotency key, recent trusted MFA and an active owner or `hr_admin` membership in that tenant. It accepts only an email and records one pending request for an existing draft/active employee. It does not call Keycloak, send mail, create an identity or create a membership. Do not interpret `202` as active employee access; employee provider reconciliation and activation are still disabled.

HTTPS is required for web/identity URLs. Plain HTTP/Redis is accepted only for loopback addresses with an explicit `NODE_ENV=development` or `test`. Cookies **always** retain Secure, HttpOnly, SameSite=Lax, Path=/ and `__Host-` names. Prefer local HTTPS when exercising a real browser; do not weaken cookies to accommodate plain-HTTP browser behavior. A production build should be tested behind same-origin HTTPS.

Before real-provider acceptance, configure and verify:

- Registration disabled at the identity provider as well as the application; no automatic company membership from email/domain or federated first login. This applies to Free and complimentary tenants too.
- Confidential client with authorization-code flow only, S256 required, RS256 ID tokens and exact callback allowlist; no wildcard redirect, implicit or password grant.
- `auth_time` emitted and `max_age=300` respected; synchronized clocks. Login requires recent authentication, and company-provisioning and employee-account actions recheck the five-minute window. Other privileged-action reauthentication remains future work.
- Reset-password and invitation/password-setup flows for administrator-provisioned accounts only, single-use expiring tokens, generic responses and mail delivery without secrets in logs. Both local Keycloak paths are tested; production email delivery and reconciliation remain future work.
- Privileged MFA policy, disabled-account behavior, key rotation, provider outages and account-recovery/session-revocation behavior verified against the actual chosen provider. The local Keycloak LoA 2 and signed reset-revocation paths are verified; production deployment and outage reconciliation are not.

The provider configuration cannot be inferred from OIDC discovery. An administrator must verify the registration and grant settings; this adapter cannot prevent a misconfigured external identity provider from creating its own users. Such users still receive no Kinto session unless separately provisioned in Kinto.

## Session storage, logout and failure behavior

Redis stores a ten-minute, single-use login transaction and an opaque server session. Browser handles are random 256-bit values; Redis keys contain their SHA-256 digests and a namespace derived from issuer/client/origin. Session records contain identity reference, verified principal, authentication time, provider session ID, CSRF token and expiry, but no passwords, ID/access/refresh tokens or tenant roles. Subject and provider-session indexes contain only SHA-256 digests and Redis session-key references. Redis must remain private and use access controls/TLS before deployment; the local container has no production credentials.

Sessions have a 30-minute idle timeout and 12-hour absolute limit, enforced atomically with Redis time. Login rotates the session and invalidates the previous handle. Concurrent reads cannot recreate a deleted session. Logout requires an exact Origin and session-bound `X-CSRF-Token`; it deletes the server session and clears the cookie. Browser logout affects this Kinto session only, not the provider SSO session.

The back-channel endpoint accepts only a signed RS256 OIDC Logout Token with exact issuer/audience, current `iat`, unique `jti`, the standard back-channel event, no nonce, and a subject or provider session ID. JWKS retrieval is bounded to the discovered exact URL. Redis consumes replay IDs and deletes all matching indexed sessions atomically; duplicate delivery is an idempotent 204. The v2 namespace intentionally signs out pre-index sessions on rollout. Invalid requests receive only the generic safe error.

Keycloak must register the exact HTTPS back-channel URL and keep “Backchannel logout session required” enabled. The real-provider reset test explicitly selects “Sign out from other devices” and proves the previously active Kinto session is deleted. Keycloak 26.7.2 leaves that option unchecked, so production policy must decide whether to preserve that choice or enforce revocation with a reviewed provider extension. Keycloak delivery is synchronous and Kinto has no durable provider-event inbox or reconciliation job, so an unavailable callback can leave a session active until expiry. Keep recovery unavailable for live users until deployment availability, failure alerting/reconciliation and this policy are approved.

Authentication endpoints share a 60-requests/minute limit per socket address. Forwarded-IP headers are ignored. Behind a proxy this is a conservative shared limit; add verified edge per-client abuse controls and review trusted-proxy deployment before production. Do not silently trust arbitrary `X-Forwarded-For` values.

Enabled authentication must initialize Redis and discovery successfully or API startup fails. Readiness includes an auth-store ping. Dependency failures deny requests with generic errors; no memory fallback bypasses session checks. The Redis client does not reconnect indefinitely: restart the API after a lost connection. Do not log callback URLs/codes, cookies, token exchanges, CSRF values or secrets at the proxy/provider.

Authentication Redis is disposable security state, not business recovery data. Do not restore old sessions/login transactions from backups; clear only the dedicated auth store or change its namespace under an approved procedure after recovery. Never flush a Redis instance shared with worker queues. A database/business restore must not resurrect old logged-out sessions. Session encryption/secret rotation and incident-wide revocation require deployment review.

## Verification and next work

Run `pnpm verify:full` using the documented local test services. The fast auth integration suite uses a loopback synthetic OIDC protocol server with actual RSA signatures, discovery/JWKS and PKCE exchange plus real PostgreSQL/Redis. The additional `pnpm test:keycloak` workflow uses the pinned real provider and actual browser/TOTP/reset-email pages against the built application. Ordinary browser tests still use disabled/mocked account UI states.

The first-operator, atomic company request, Keycloak initial-owner activation and pending employee-account request boundaries are implemented; see [company-request evidence](../evidence/phase-01/company-provisioning.md), [owner-invitation evidence](../evidence/phase-01/owner-invitations.md) and [employee-account request evidence](../evidence/phase-01/employee-account-requests.md). Next: employee provider delivery/activation, membership administration and last-owner protection. Provider delivery failure/reconciliation and identity-disable synchronization remain production recovery gates. Company/policy administration and employee CRUD APIs remain closed until their authorization/lifecycle requirements are complete. See the [roadmap](../implementation/README.md).
