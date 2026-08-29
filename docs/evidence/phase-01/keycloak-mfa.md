# Keycloak MFA and provider-recovery evidence

Date: 29 August 2026. Scope: bounded local P01-02 provider-profile verification, not production identity/recovery approval or completed account provisioning.

## Delivered

- Explicit `OIDC_MFA_PROFILE`: `none` is the default and trusts no MFA claim. `keycloak-loa2-v1` requests essential `acr=2` and marks MFA verified only when the fully verified signed ID token returns that exact string. Numeric/other/missing ACR, arbitrary `amr`/roles and generic providers cannot enable it.
- Keycloak 26.7.2 pinned by immutable image digest. The generated localhost-only realm disables registration, implicit/password/service-account grants and wildcard callbacks; enables one confidential S256/RS256 client; and binds a two-level browser flow: username/password at LoA 1, required TOTP at LoA 2 with no reusable assurance age.
- A password-reset-only flow with generic response, local email action token, short test expiry and no OTP-reset execution. Email possession/password replacement cannot directly create a Kinto MFA session; TOTP is still required on subsequent login.
- `pnpm test:keycloak`: isolated real-provider runner using actual built NestJS/Next.js, Chromium, generated self-signed localhost HTTPS proxy, real PostgreSQL/Redis, loopback in-memory SMTP sink, random fixture accounts/credentials, and scoped cleanup. It is appended to `verify:full` and CI.
- No signup/provisioning endpoint, default password, production realm export, customer data or production identity service. Only one pre-provisioned synthetic issuer/subject is linked to one synthetic tenant; the other provider user is rejected by Kinto.

## Verification

The real-provider workflow passed **8 scenarios**:

1. Invalid OTP cannot produce a session; password plus current TOTP produces a Secure/HttpOnly/SameSite session with `mfaVerified=true`, and an owner membership passes a fresh authorized-tenant check.
2. Kinto logout removes both the browser handle and Redis session.
3. Keycloak registration, direct password grant and an unlisted redirect URL are denied.
4. A deliberately downgraded, signed password-only LoA 1 response is rejected by the configured Kinto MFA profile.
5. A valid provider user without a pre-provisioned Kinto identity/membership receives no Kinto session and creates no records.
6. Anonymous unknown/existing password-reset requests show the same visible response, while SMTP receives mail only for the existing account.
7. A real email action changes the password, cannot bypass TOTP, retains the OTP credential, rejects link replay, and cannot restore a separately revoked Kinto membership.
8. A second reset link becomes unusable after the configured short test lifetime and cannot present the password-change form.

Private synthetic report: `.local/keycloak/run-gHjUs8/report.json` (ignored by Git). Generated passwords/TOTP/client secret, realm import and TLS key were deleted by cleanup. The uniquely named container, child processes, test database rows and only the fixture's Redis namespace were removed. No shared Redis/database/container cleanup was used.

The fast synthetic OIDC integration suite added five provider-profile cases and passed 26 auth cases total: the default profile still rejects MFA trust even for signed LoA 2, explicit LoA 2 succeeds, and LoA 1/numeric/missing/other ACR fail. Existing signature/issuer/audience/nonce/expiry/replay/CSRF/revocation cases remain intact.

No schema migration or new npm dependency was required. The Keycloak image is test tooling, not an application runtime dependency. `pnpm verify:full` passed locally: 61 unit/API/monitoring tests with 100% selected coverage, 55 PostgreSQL/Redis integration tests, migration upgrade/replay and two-tenant isolation, the synthetic recovery drill, all production builds, 4 built-worker runtime tests, 12 desktop/mobile browser tests, and the 8 real-provider scenarios above. Remote GitHub Actions and production provider security review remain unverified.

## Deliberate limitations and next step

The profile's `acr=2` meaning depends on this exact reviewed Keycloak flow and mapper. It must be re-tested after any provider version, authentication-flow, client or mapper change. It currently requires TOTP for every login through this client; selective role-based step-up and alternative MFA methods are not delivered.

The subsequent [session-revocation increment](session-revocation.md) adds and locally verifies signed OIDC back-channel deletion when the provider's sign-out-other-devices reset option is selected. Recovery remains non-production because that option is unchecked by default, callback outage reconciliation, identity-disable synchronization, production email/HTTPS/provider database, MFA recovery, edge abuse controls and key rotation remain gates.

Protected first-operator/company-owner provisioning, company-admin/HR employee invitations and activation, membership administration/selection, last-owner protection and security audit are still missing. Authentication remains disabled by default; no employee/business API has been opened. Next application work is administrator-only provisioning. See [operations](../../operations/keycloak.md) and the [roadmap](../../implementation/README.md).
