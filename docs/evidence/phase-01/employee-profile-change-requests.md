# Employee contact change requests

Date: 22 September 2026
Scope: P01-05 employee-submitted contact/emergency proposal, without HR decision or profile mutation.

An employee with an active linked account, selected tenant and recent trusted MFA can submit a complete proposed snapshot of personal email, mobile phone and emergency contact through `POST /api/v1/tenants/{tenantId}/me/profile-change-requests`. The request requires same-origin CSRF, a UUID idempotency key, an expected contact version and a reason. Unknown fields, including CNIC, address, salary, manager, role and status, are rejected. The employee can list up to 100 own requests with `GET` on the same path.

The constrained database function derives employee identity from the active membership/link, serializes requests under the employee row lock, checks the current contact version, rejects no-op proposals and allows only one pending request per employee. An exact retry returns the original request; changed reuse conflicts. The submitted proposal is stored under forced RLS with no direct application-table access. Audit and outbox facts contain only identifiers and a fixed reason, never proposed contact values. Submission does not alter `employee_private_details` or grant HR authority.

Synthetic PostgreSQL tests cover concurrency/replay, stale version, changed key, no-op, second pending request, role denial, direct-table denial and unchanged approved details. HTTP tests cover strict body, session, Origin/CSRF and idempotency key. Migration replay and synthetic database restore include the table. HR review/approval/rejection, notifications, a UI, retention rules and field-encryption deployment review remain open; do not use with customer data.
