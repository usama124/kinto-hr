# Foundation acceptance gaps

Repository review on 2 October 2026, starting from merged main `92623c3` (PR 52). This is a local engineering checklist, not security sign-off or production acceptance. It compares the [Phase 1 specification](../../implementation/PHASE-01-PLATFORM-PEOPLE.md), current API/screens, CI workflow and evidence records; no external gates were approved.

## Local review outcome

- P01-01: repository/build/CI, restricted roles, migration replay, workers, monitoring and synthetic database restore are implemented. CI already inventories business tables during restore and checks forced RLS. Approved deployed environments, backup/PITR/file recovery, delivered alerts and remote CI evidence still need separate validation.
- P01-02: company/operator provisioning, invitations, OIDC/MFA, tenant selection, memberships, organization policies and audit access have local implementation/evidence. Employee-account provisioning existed in the API but was missing from employee records; the [employee account workspace](employee-account-workspace.md) closes that bounded UI gap. Production provider callback reconciliation and identity-disable synchronization remain open.
- P01-03: base plans, effective capacity, grants/overrides, previews/history and creation/revocation receipts are implemented locally. This does not implement commercial prices, invoices, collections or renewals.
- P01-04: organization/lifecycle/history, contact/CNIC data, salary history, checklists and explicit post-rehire access reactivation are implemented. The existing private-details DTO does not capture bank details; optional bank capture is not claimed complete. Attendance/leave/payroll calculations remain later phases.
- P01-05: CSV validation/atomic confirmation, document quarantine/local-test transfer/scan/download/replacement, employee-visible documents, contact-change decisions and workforce exports have local workflows. Production object transfer/scanning, approved retention purge and file recovery remain incomplete.

## Schema classification gap closed — 3 October 2026

The [schema isolation classification gate](schema-isolation-classification.md) now inventories every business table, exact RLS policies, role/table/column privileges and domain regression references. CI, isolated migration upgrades and restored snapshots enforce it. The independent restore whitelist remains. This satisfies the bounded local gap described in the original review without approving deployed security.

## Provider disable enforcement slice — 3 October 2026

The [opt-in provider identity-status guard](provider-identity-status.md) checks exact provider state at login/session access. Confirmed disable revokes same-identity sessions, unconfirmed state temporarily denies access, and company-specific revocation never disables a shared provider identity. It leaves local identity status untouched and remains disabled by default. It is not durable event synchronization or deployed approval.

## Durable accepted-logout slice — 3 October 2026

The [durable provider logout inbox](durable-provider-logout.md) persists verified hashed receipts before acknowledgment. Pending and completed receipts deny affected sessions independently of Redis cleanup; bounded fair retries survive API restart and completion failure. The new control-plane table is included in isolation and restore verification. This does not recover provider callbacks that never reach Kinto or synchronize permanent identity status.

## Private logout monitoring slice — 3 October 2026

The [private logout health command](provider-logout-monitoring.md) reads only namespace aggregates, signals overdue work or stalled attempts, bounds dependency failures and exposes no receipt identifiers. It is a local operations command, not deployed alert delivery or a provider heartbeat.

## Next bounded local step

Review optional employee bank-detail capture with separate recent-MFA authorization, safe projections and regression coverage; salary transfers remain outside Kinto. Production storage/scanning, approved retention and deployment acceptance are still external gates. Deployed alert delivery, provider retry/availability policy, consistent API configuration and staging/security acceptance still require separate operational approval.

## External and deployment gates remain

Product/engineering approval must resolve pilot scope, deployment/vendor/budget and privacy/retention decisions before live customers or personal records are used. Operations must verify staging identity/provider reconciliation, disable synchronization, alert routing, backup/PITR/file recovery and remote release evidence. Approved production storage/scanning and file access must replace the off-by-default local document adapter before live documents are accepted. Human staging/security acceptance is still required.

Real K50 connectivity/firmware/SDK distribution and independently reviewed Pakistan payroll rules/fixtures remain Phase 0 dependencies for later attendance/payroll acceptance. Local connector fixtures or calculated examples cannot satisfy those gates. No full Phase 0 or Phase 1 completion, device compatibility, legal compliance or production readiness is asserted by this review.
