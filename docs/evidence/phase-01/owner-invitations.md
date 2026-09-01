# Initial-owner invitation evidence

Date: 30 August 2026. Scope: bounded P01-02 Keycloak reconciliation, provider-managed setup delivery and atomic first-owner activation using synthetic local data. This is not production identity-provider or email-delivery approval.

## Delivered

- Account provisioning remains disabled by default. The only adapter mode is the explicitly reviewed Keycloak LoA 2 profile with a dedicated confidential management client; generic OIDC providers cannot enable it.
- A protected company request creates or exactly reconciles the requested provider email. New provider users start disabled. Reconciliation requires one exact email match; an existing enabled account must already have provider-verified email, while retrying a disabled account requires the request marker. Ambiguous, enabled-unverified and unmarked disabled accounts are denied. Existing provider attributes are preserved.
- Kinto records only the provider issuer/subject, invitation identity binding, status and expiry. It stores no provider action token or password. Only after the database reconciliation succeeds does the adapter enable the user and ask Keycloak to send `VERIFY_EMAIL`, `UPDATE_PASSWORD` and `CONFIGURE_TOTP` actions with a 48-hour lifetime and fixed allowlisted redirect.
- Provider or database failures return the safe pending state and create no membership. Replaying the same operator request reuses the reconciled identity/invitation and does not resend an unexpired delivered invitation.
- Exact-subject trusted MFA resolves the single pending invitation in PostgreSQL. One locked transaction verifies the active tenant/request, unexpired delivered invitation and absence of any existing company membership, then inserts exactly one owner membership, accepts the invitation, activates the request and writes tenant/platform audit events. Wrong identity, missing MFA, expiry, replay and concurrency grant no extra access.
- Forced RLS remains enabled on identities, memberships and owner invitations. Constrained `SECURITY DEFINER` functions are owned by the NOLOGIN control owner; the runtime role has no unrestricted control-plane write grant.

## Verification

Focused adapter/service tests cover secure configuration, disabled-first creation, exact reconciliation, marker and attribute preservation, fixed redirect/action/lifetime values, ambiguous or untrusted responses, database-before-email ordering, safe partial failure and resend suppression.

The PostgreSQL/Redis/OIDC integration suite passes 72 cases. New cases prove exact/idempotent reconciliation, conflicting subject denial, idempotent delivery, trusted-MFA requirement, wrong-identity/expiry denial, and two concurrent login callbacks producing one owner membership and one accepted invitation.

The pinned Keycloak 26.7.2 real-browser workflow passes 9 scenarios. Its new scenario calls the built protected platform API, observes no membership before activation, receives an actual provider setup email, completes the provider's TOTP/password/profile actions, signs in through real OIDC LoA 2, and verifies one owner membership plus active request/accepted invitation. The private ignored report is `.local/keycloak/run-uHfvih/report.json`.

Final local verification passes formatting, lint, TypeScript, documentation links, 76 unit/API tests with 100% selected coverage, 72 PostgreSQL/Redis/OIDC integration tests, clean/upgrade migration replay with six migrations, the synthetic restore drill including owner invitations, all production builds, 4 built-worker runtime tests and 12 desktop/mobile browser tests. The private recovery report is `.local/recovery/2697c41a7f254003a974462e632de272/report.json`. Remote GitHub Actions remain unverified until the branch is pushed.

## Deliberate limitations and next step

Provider delivery is synchronous with the platform request and bounded by request timeouts. There is no durable provisioning worker, provider delivery-status callback, automatic retry schedule, invitation revoke/resend API or operator reconciliation screen. An existing active exact-email Keycloak user can accept the approved invitation through trusted MFA after delivery; a newly created user cannot authenticate before completing setup because it starts disabled and has no password.

The disposable realm grants broad management scope only to make its generated import portable; production must map and review least-privilege user-management roles. Production email/Keycloak infrastructure, secrets, alerts, identity-disable synchronization, failure reconciliation and recovery approval remain gates. This slice includes no employee provider provisioning or activation, membership administration, last-owner protection, company setup UI or customer security-audit UI. Subsequent slices add the protected employee request and activation boundaries.

Employee and administrator provider reconciliation/setup/activation plus owner membership administration/last-owner protection are now locally implemented; see [employee activation evidence](employee-account-activation.md), [administrator invitation evidence](administrator-invitations.md) and [membership-administration evidence](membership-administration.md). Next P01-02 work is tenant selection and customer security-audit access. See [authentication operations](../../operations/authentication.md), [Keycloak operations](../../operations/keycloak.md) and the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md).
