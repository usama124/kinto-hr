# Local Keycloak verification

29 August 2026 · Synthetic development/CI only. No live company onboarding.

## Scope

The `keycloak-loa2-v1` MFA profile is an explicit trust contract with a reviewed Keycloak authentication flow. It is not a universal interpretation of an arbitrary provider's `acr` claim. `OIDC_MFA_PROFILE=none` remains the default and never marks MFA verified.

With the Keycloak profile selected, Kinto requests essential `acr=2` and requires the signed ID token to return that exact string, in addition to all existing issuer/audience/signature/nonce/expiry/authentication-time checks. The reviewed flow uses level 1 for username/password and level 2 for required TOTP, with zero reusable assurance age. It has no alternative bypass or hardcoded claim mapper. The built-in ACR mapper reports the achieved level. A password-only/downgraded token cannot create a session under this profile. This profile requires TOTP for every login through that client, not only owners; role-based step-up is future work.

Do not enable the profile on a realm merely because its tokens contain `acr=2`. Review the actual flow, client binding, mapper and allowed authentication methods. The fixture under `infra/keycloak/test-realm.ts` is deliberately restricted to generated `kinto_test_*` realms and localhost HTTPS callbacks. It is not a production realm export or an administrator provisioning tool.

## Repeatable verification

Use the pinned Node/pnpm versions, Docker on Linux, OpenSSL, installed Playwright Chromium and the local test PostgreSQL/Redis described in the root README. Database names must start with `kinto_test`; database/Redis hosts must be loopback. Apply migrations and bootstrap restricted database roles first.

```sh
pnpm build
pnpm test:keycloak
```

The test also runs at the end of `pnpm verify:full` and in GitHub Actions. It is mandatory there, not silently skipped when Docker is missing. Allow roughly two minutes for container startup and the real reset-token expiry test; the first image download takes longer.

The runner uses Keycloak **26.7.2**, pinned to `sha256:9d1f1b2b7261ff53c66cb1092dfcdc34a5fb77e81f9e6a6e75b8b6a795de8067`. It creates a uniquely named disposable container with a temporary development database, one generated realm, random passwords/TOTP/client secrets and two synthetic identities. Only the designated fixture owner is provisioned in the Kinto test database. It never creates real companies or rewrites `.env`.

The container uses host networking to reach the loopback SMTP sink, with its HTTP listener explicitly bound to `127.0.0.1`; this workflow is Linux-only. It runs as the invoking UID with container group 0, not with host administrator credentials. Memory/CPU are bounded. All temporary API, web, HTTPS and SMTP listeners also bind to loopback. Do not reuse this development container setup for deployment.

The test launches the actual built NestJS and Next.js applications. A temporary localhost HTTPS proxy presents an ephemeral self-signed certificate; Chromium ignores certificate errors only inside its isolated test context. Kinto's cookies remain Secure/HttpOnly/SameSite=Lax. No global TLS validation switch, machine trust-store change or insecure cookie exception is used. The API receives its restricted database and client credentials only, not migration credentials.

The SMTP sink captures reset messages in memory and cannot forward mail. Tests use real Keycloak pages, signed tokens and reset-email links. There is no synthetic replacement for the provider in this workflow. It complements the faster synthetic OIDC negative-case integration tests.

Private pass/failure reports live under `.local/keycloak/run-*/`, which is ignored by Git and excluded from CI artifacts. Passwords, OTP imports and private TLS keys are deleted in cleanup. Container, fixture processes, test identities/membership and only their Redis namespace are removed. No shared Redis flush or existing-container deletion occurs. A forcibly killed test may need cleanup of its specifically named `kinto-keycloak-test-*` container and private run directory; never apply blanket Docker/database cleanup.

## Recovery boundary and remaining gates

The fixture disables registration in Keycloak and rejects direct password grants and unlisted redirect URLs. Password recovery sends to an existing account only, uses a generic response, and requires a short-lived email action token. The custom reset flow changes the password but deliberately excludes OTP reset. Users without TOTP must enroll it through a protected account-activation process before this becomes a customer workflow; activation is not implemented here.

The client registers Kinto's exact back-channel endpoint and requires a provider session ID in signed logout tokens. The real browser workflow creates a Kinto session before reset, explicitly selects “Sign out from other devices,” and proves Keycloak's signed callback invalidates it after the password changes. Kinto also verifies issuer, audience, signature, age, event, nonce absence and replay before atomically revoking matching sessions.

**Recovery is not production-ready.** A user can deselect Keycloak's sign-out-other-devices option, and callback delivery has no durable retry/reconciliation when Kinto is unavailable. Production must explicitly enforce or accept that provider choice and add availability alerts/reconciliation. Identity-disable synchronization, MFA recovery, production email/HTTPS/provider database, edge abuse controls and security review also remain gates.

This increment does not create an admin UI, first platform operator, company owner or employee account workflow. Those remain administrator-only under C11–C12, with invitation/activation, tenant scoping, last-owner protection and audit still required. Production Keycloak database/backups, HTTPS, email delivery, abuse protection, secrets, availability and security review remain unapproved. `AUTH_MODE=disabled` stays the default.

Reference: Keycloak's [step-up and recovery configuration](https://www.keycloak.org/docs/latest/server_admin/index.html) and the pinned version's [release notes](https://www.keycloak.org/2026/08/keycloak-2672-released). Run the browser verification again after any provider version, flow, mapper or authentication-policy change.
