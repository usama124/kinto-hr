# Scheduled employee termination evidence

Status: locally verified · 9 September 2026 · P01-04 increment

## Delivered boundary

- Owner/HR users with recent MFA can schedule an active employee's final working date with an optimistic version and required audit reason. Unknown, stale, repeated, past-date, cross-tenant and incomplete requests fail closed.
- The active employment period stores the approved date, actor, reason and schedule timestamp. Assignments are bounded to the final day, while the employee remains active and continues consuming a seat through that date.
- Scheduling a manager is rejected while an active report would still point to that manager after the final day. Already scheduled employees cannot receive assignments beyond the approved date.
- The restricted dispatcher calls one fixed batch-limited database function. On the first employer-local day after the final working date it atomically marks the employee terminated, ends the employment period, releases capacity, records audit/outbox facts and revokes the linked membership, account request and invitation.
- Revocation is tenant-specific. The provider identity and memberships in any other company are unchanged. Existing sessions consequently lose this company on the next server-side membership check; no provider-wide logout or identity disable is claimed.
- The employee workspace exposes scheduling and displays the approved final date. There is no immediate-termination control and no client field can choose tenant, actor, status or revocation scope.

## Verification

- Contract/API tests cover strict date/version/reason input, recent-MFA context and rejection of client-supplied revocation controls.
- PostgreSQL integration tests cover history preservation, stale/repeated/role/MFA/tenant failures, active-report blocking, application-role direct-write denial, one-time due application, seat release and linked-access revocation without cross-company identity damage.
- This increment passed 126 integration tests and 20 migrations when delivered. The subsequent archive increment advances the current totals and preserves terminated history without changing this boundary.
- Responsive browser coverage creates, activates and schedules separation for a complete employee. The build, restricted worker runtime, formatting, lint, type checks, selected coverage and documentation-link checks remain part of the full verification matrix.

## Remaining P01-04 work

Archive is delivered in the [next evidence increment](employee-archive.md). Rehire remains next. Private employee details, permission-separated compensation history and onboarding/offboarding checklists are also incomplete. Provider delivery/reconciliation and production operational approval remain gates. This preview is not approved for customer data.
