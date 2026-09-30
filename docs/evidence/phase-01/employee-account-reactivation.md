# Employee account reactivation after rehire

Date: 29 September 2026
Scope: explicit restoration of an existing verified employee login after a completed employment rehire.

Employment rehire still restores no access by itself. The employee roster now exposes only an account-access state (`not_provisioned`, `active` or `revoked`) and the membership version; it exposes no provider subject, identity ID or account email. When an active employee has more than one employment period and a retained revoked binding, an owner or HR administrator can submit a separate reasoned restoration command from the employee workspace.

`POST /api/v1/tenants/{tenantId}/employees/{employeeId}/account/reactivation` requires selected-tenant session binding, same-origin CSRF, trusted MFA within five minutes, a positive expected membership version and a 3–240 character reason. A fixed-search-path security-definer function rechecks active owner/HR authority, active rehired employment with a previous ended period, the exact retained employee/identity/membership/invitation/request chain, active global identity, revoked component states and the fixed employee-only role. It atomically restores that existing membership, request and invitation, increments their versions, writes a reasoned audit event and emits a payload-free `employee.account_reactivated.v1` fact. It cannot select a replacement identity, email or role and never creates a provider account.

PostgreSQL tests cover successful restoration, stale/repeated commands, missing MFA, cross-tenant calls, disabled identity denial, safe roster projection, audit/outbox uniqueness and direct runtime write denial. HTTP tests cover strict input and CSRF/session context. The complete employee lifecycle browser journey now continues through explicit login restoration on desktop and mobile. The durable observer recognizes the new committed fact without receiving employee data or mutating workflow state.

## Local verification

- `pnpm verify` passed formatting, lint, type checks, all 23 unit/API files with 158 tests and documentation validation with 109 local links.
- All 19 integration files with 150 tests passed. All 39 migrations passed isolated clean baseline, upgrade/bootstrap and replay verification.
- The synthetic database restore equality drill passed with all 39 migrations, and all four built worker/monitor runtime checks passed.
- API, web and worker production builds passed. The complete Playwright suite passed all 32 desktop/mobile scenarios, including the extended lifecycle journey.

## Deliberate limitations

This flow restores only a previously verified, still-active provider identity. A disabled or missing identity requires operator/provider investigation; the command cannot substitute another account. It does not provide administrator reactivation, identity-disable synchronization, provider-wide logout, durable invitation delivery or production identity-provider approval. Those remain operational security gates.
