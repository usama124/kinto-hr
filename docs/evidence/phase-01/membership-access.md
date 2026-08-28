# Membership access foundation evidence

Date: 28 August 2026. Scope: a bounded P01-02 persistence/authorization prerequisite, not a completed login system.

## Delivered

- Global identities keyed by exact issuer/subject, and tenant-owned memberships with status, predefined roles and version. No email-domain matching or automatic company/membership creation.
- Forced RLS on both tables. Identity reads require exact transaction-local issuer/subject context; membership reads additionally require tenant context and the matching identity. The API database role has SELECT only; worker/dispatcher roles have no identity/membership grants.
- `inAuthorizedTenant` resolves current identity/membership, checks active state and permission, requires a verified MFA signal for privileged roles, then runs work in the same tenant transaction with authoritative actor IDs. No cached membership means revocation/role changes take effect on the next authorization check. A transaction already authorized is not forcibly cancelled by a concurrent revocation.
- Unknown identity/missing or revoked membership, disabled identity, suspended tenant, missing MFA and insufficient permission fail closed. Owners/HR gain no implicit payroll permission. Unsupported platform-operator tenant roles are rejected.
- Restore verification now compares eight tables, restores two synthetic identities/memberships and verifies authorized access plus cross-company denial afterward.

## Integration boundary — important

`AuthenticatedIdentity` is an **internal contract**, not proof of authentication. Only a future verified OIDC/server-session adapter may populate it. Do not construct it from request headers, body, query parameters, decoded-but-unverified tokens or arbitrary provider MFA claims. All authorized work must stay in the supplied transaction; do not check access and then invoke an unscoped persistence helper in a second transaction.

Existing employee helpers remain internal architecture fixtures. No authenticated business route, fake login or membership-admin endpoint is enabled by this slice. Identity/membership records are provisioned by test fixtures only; there is no production bootstrap workflow. Passwords, tokens, sessions and identity-provider secrets are not stored in these tables.

## Verification

`pnpm verify:full` passed locally: **88 tests** (47 unit/API/monitoring, 29 PostgreSQL/Redis integration, 4 built runtime, 8 browser), plus isolated migration upgrade/replay and database restore. Added eight focused real PostgreSQL tests for transactional authorized writes/rollback, membership/issuer boundaries, MFA/role denial, revocation, runtime provisioning denial and pooled context isolation.

Prisma generation, formatting, lint, root/web typechecks and all production builds passed. Selected contract/domain/config coverage gates passed at 100%, not whole-application coverage. The final documentation check validated 10 planning documents/45 local links; `git diff --check` passed. No new dependencies were needed.

The eight-table restore passed with restored identities/memberships and cross-company denial. Private fixture report: `.local/recovery/3b7323158ef946188e3e8aee705731ae/report.json`. No backup data or generated clients are committed. GitHub Actions was not run remotely by this work.

## Next work

OIDC provider configuration and maintained protocol adapter; PKCE/state/nonce/signature/issuer/audience checks; tested provider MFA claims; secure server sessions and cookies; CSRF/origin checks; logout/expiry; protected invitations and first-owner setup; membership administration with last-owner and audit safeguards. Then company/policy administration. None of these are implied to be implemented by the new persistence boundary. Foundation/Phase 1 and deployed operational gates remain incomplete.
