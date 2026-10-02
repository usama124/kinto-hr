# Foundation acceptance gaps

Repository review on 2 October 2026, starting from merged main `92623c3` (PR 52). This is a local engineering checklist, not security sign-off or production acceptance. It compares the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md), current API/screens, CI workflow and evidence records; no external gates were approved.

## Local review outcome

- P01-01: repository/build/CI, restricted roles, migration replay, workers, monitoring and synthetic database restore are implemented. CI already inventories business tables during restore and checks forced RLS. Approved deployed environments, backup/PITR/file recovery, delivered alerts and remote CI evidence still need separate validation.
- P01-02: company/operator provisioning, invitations, OIDC/MFA, tenant selection, memberships, organization policies and audit access have local implementation/evidence. Employee-account provisioning existed in the API but was missing from employee records; the [employee account workspace](employee-account-workspace.md) closes that bounded UI gap. Production provider callback reconciliation and identity-disable synchronization remain open.
- P01-03: base plans, effective capacity, grants/overrides, previews/history and creation/revocation receipts are implemented locally. This does not implement commercial prices, invoices, collections or renewals.
- P01-04: organization/lifecycle/history, contact/CNIC data, salary history, checklists and explicit post-rehire access reactivation are implemented. The existing private-details DTO does not capture bank details; optional bank capture is not claimed complete. Attendance/leave/payroll calculations remain later phases.
- P01-05: CSV validation/atomic confirmation, document quarantine/local-test transfer/scan/download/replacement, employee-visible documents, contact-change decisions and workforce exports have local workflows. Production object transfer/scanning, approved retention purge and file recovery remain incomplete.

## Next bounded local step

Make the Phase 1 data-model requirement explicit in CI: maintain a schema isolation inventory mapping every business table to its tenant/control-plane scope and regression test classification. Extend existing synthetic catalog/isolation/migration checks so an added table, missing classification or incorrect tenant policy fails. The existing restore table whitelist and forced-RLS checks are retained, but are not a documented per-table scope/test inventory. No new tenant table should be approved merely by updating a count.

This step can proceed without live identities, paid infrastructure, K50 hardware or payroll assumptions. It is separate from deployed security acceptance and must not weaken restricted roles or RLS to make tests pass.

## External and deployment gates remain

Product/engineering approval must resolve pilot scope, deployment/vendor/budget and privacy/retention decisions before live customers or personal records are used. Operations must verify staging identity/provider reconciliation, disable synchronization, alert routing, backup/PITR/file recovery and remote release evidence. Approved production storage/scanning and file access must replace the off-by-default local document adapter before live documents are accepted. Human staging/security acceptance is still required.

Real K50 connectivity/firmware/SDK distribution and independently reviewed Pakistan payroll rules/fixtures remain Phase 0 dependencies for later attendance/payroll acceptance. Local connector fixtures or calculated examples cannot satisfy those gates. No full Phase 0 or Phase 1 completion, device compatibility, legal compliance or production readiness is asserted by this review.
