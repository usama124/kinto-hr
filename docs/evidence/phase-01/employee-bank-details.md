# Optional employee bank details

Local P01-04 increment, 3 October 2026, starting from merged main `f495d55` (PR 57). No live employee data, bank integration or payment was used.

## Boundary

Bank details are optional and separate from contact/CNIC information. Migration 49 adds `employee_bank_details`: tenant/employee composite foreign keys, a single versioned record per employee, forced tenant RLS and control-owner-only table privileges. The API runtime, workers and dispatcher cannot read or write the table directly. Dedicated fixed-search-path functions have a non-login control owner; only the API runtime executes public bank commands. The internal authorization helper has no runtime execute grant.

`GET /api/v1/tenants/:tenantId/employees/:employeeId/bank-details` permits active payroll preparers and approvers with recent MFA. `PUT` permits only preparers and requires selected-tenant context, recent MFA, same-origin CSRF, expected version and a reviewed change reason. Owner, HR, employee and platform operator roles alone do not grant access; someone with explicitly assigned payroll and HR roles can use both respective workspaces. Existing permission rules are not broadened. Reads also check active company, identity and membership. Terminated/archived employee records can be read for approved retention, but cannot be edited.

Fields are bank name (1–120 characters), account title (1–160) and account number or IBAN reference (1–34 letters/digits). Spaces in the reference are removed, letters uppercased and leading zeroes retained. This is format validation only: no bank ownership, routing validity, IBAN country/length/checksum or Pakistan bank approval is claimed. Arbitrary banking identifiers with punctuation need a reviewed contract change rather than silent conversion.

## Versioning, clearing and privacy

First capture uses expected version 0; concurrent first writes are serialized on the employee row and exactly one succeeds. Updates require the current version. Membership locking serializes writes with role/revocation changes, without granting the control owner new company/identity update permissions. Employee locking also prevents a concurrent termination from accepting a later bank edit.

All three fields must be present together or null together. An initial empty record is refused. Clearing keeps a null-field record and increments its version, so a stale client cannot restore old values using version 0. This clears the current record; it is not a purge of historical backups or an approved retention policy.

Reasons are structured categories: `initial_setup`, `account_change`, `details_correction`, `clear_details`. Clear category is required exactly for a clear. Arbitrary free-text reasons are rejected to prevent accidental bank-value copies in audit/event text. Atomic audit actions are created/updated/cleared; the outbox contains only employee reference and version. Neither bank values nor arbitrary reasons reach queues, roster, private-contact views, workforce exports or normal audit projections. The foundation observer consumes the minimal bank-change event once without reading the bank table, sending email or initiating any payment. No bank history/export/payment endpoint or global account deduplication is introduced.

## Workspace

The employee workspace shows bank controls only to explicit payroll roles alongside their independently authorized HR roster access. Values load on explicit request, never with the roster, and stay in component memory rather than browser storage. The preparer form supports capture/update and confirmed clearing. Approvers have read-only display. Terminated/archived records have read-only display even for preparers. Stale writes require reload; denied reads/writes discard displayed values. Uncertain saves instruct the user to reload before retrying. This UI permission hint never replaces SQL authorization.

## Verification

- `pnpm verify`: formatting, lint, types, coverage thresholds and **189 unit/API tests in 26 files** passed.
- `pnpm test:integration`: **190 tests in 19 files** passed, including dedicated-route/CSRF validation, recent/null MFA, roles, inactive company/identity, revoked membership, cross-tenant employee IDs, concurrent first writes/revisions, stale versions, direct-table denial, explicit clearing, terminated/archived edit denial and redacted projections/events. The worker consumes bank-change references once while direct financial access stays denied.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: **86 desktop/mobile tests** passed. Bank cases cover no automatic fetch, client format rejection, normalized leading zeroes, confirmed clearing, stale-write reload, denied-write value removal, HR hiding, approver read-only display and denied refresh. A desktop grid collapse found by the initial run was corrected before this passing run.
- `pnpm test:schema-isolation`: **43 business tables** passed exact forced-RLS/policy/grant classifications.
- `pnpm test:migrations`: **49 migrations** passed isolated baseline upgrade, bootstrap, replay and classification.
- `pnpm test:recovery`: both saved and cleared bank versions survived restore, restricted reads remained enforced and all three restored bank-change events were consumed safely once. Private report: `.local/recovery/7a19d7d35eba458996b2539a262fc6b1/report.json` (ignored), with `employeeBankDetailsPreserved` and `employeeBankChangeEventsConsumed` true.
- `pnpm build`: API, web and worker production builds passed; the worker was rebuilt again after its observer allowlist update.

`pnpm test:worker:runtime`: all **4 built-worker tests** passed, including startup/configuration failure and bounded shutdown checks. Real Keycloak scenarios were not rerun for this bank-data increment; no provider protocol changed, and the existing CI step remains. No remote CI, deployed storage/key management or production approval is claimed.

An unrelated synthetic database drift was found while running the existing document-concurrency regression: its installed registration function lacked the advisory lock already present in main's source migration. The local function was reconciled from that repository definition without changing any published migration or resetting business records. Isolated migration verification proves the current repository migration chain separately.

## Rollout and remaining gates

Apply migration 49, regenerate Prisma and bootstrap restricted roles before deploying the updated API/workspace. No bank values are seeded outside disposable synthetic fixtures. Rolling back the UI/API does not delete captured data; retain the restricted table and follow an approved retention procedure. Changing financial role assignments is an explicit owner action and must follow existing membership/MFA rules.

Encryption and managed keys, hosting/privacy review, production backup/file/PITR recovery and retention are still deployment/security decisions; this increment stores restricted values without introducing field encryption. No live personal/bank information is approved by these local tests. Salary payments remain external to Kinto; payroll generation and statutory calculations remain Phase 3.

Next local step: consolidate foundation release-readiness evidence and unresolved deployment gates for review. Full foundation production acceptance remains open.
