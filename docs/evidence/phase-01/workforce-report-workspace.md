# Workforce report workspace

Date: 29 September 2026
Scope: responsive P01-05 aggregate headcount reporting and audited CSV export client.

`/reports` is available only to a selected company owner or HR administrator. The client validates the authenticated session and role before requesting report data; the API remains the authorization authority and requires recent MFA. Employee-only sessions are denied without a report request. Signed-out and no-company states direct the user back to account access.

The workspace uses explicit Asia/Karachi report dates and the shared bounded-date contract. It shows headcount, joiners, leavers, unassigned headcount and department aggregates without employee or compensation fields. Invalid or greater-than-366-day periods are rejected before a request, while the API independently validates all parameters.

An owner or HR administrator can give an audit reason and request the CSV for the exact displayed snapshot parameters. The client supplies same-origin CSRF and a UUID idempotency key. A failed request retains that key in component memory for a safe retry; accepted requests clear it. No key, credential or report is stored in local or session storage. Pending artifacts are polled through the authorization endpoint, and the audited content link appears only when the artifact is ready. Expired exports require a new request.

Responsive styles keep the controls, metrics, department table and export action usable at the 360-pixel test viewport. Browser tests cover aggregate rendering, invalid date rejection, exact parameters, CSRF, stable-key failure/retry, pending-to-ready polling, protected download URL, employee denial, no horizontal page overflow and empty browser storage on desktop and mobile.

## Local verification

- `pnpm verify` passed formatting, lint, type checks, all 23 unit/API files with 156 tests and documentation validation with 106 local links.
- `pnpm build` passed for API, web and worker, including static generation of `/reports`.
- The complete Playwright suite passed all 32 desktop/mobile scenarios; four exercise the HR report/export workflow and employee denial.

## Deliberate limitations

The workspace provides the first aggregate workforce report only. Attendance, leave, payroll and department-cost reports belong to later phases. Production object transfer/scanning/download, deployed file recovery, staging approval and the full Phase 1 acceptance gate remain open.
