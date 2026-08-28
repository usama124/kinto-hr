# Phase 4 — subscriptions, operations and commercial release

Version 1.0 · 28 August 2026 · Status: not started · Estimate: 3–5 engineering weeks; live-cycle gates may extend elapsed time

Dependencies: [Phases 1–3](README.md), [shared spec](SYSTEM-SPEC.md), decisions E03–E06/E09. Next: [Phase 5](PHASE-05-EXPENSES-ASSETS.md).

## Objective, entry and boundaries

Turn the working pilot into a supportable subscription product with enforceable access, honest billing, recovery procedures and proven payroll accuracy. Product/finance, company owner, platform operator and payroll approver are the principal actors.

Manual invoices and independently approved bank-transfer reconciliation are the production billing baseline. Automated recurring collection is an optional gated integration, not a prerequisite for manually renewed subscriptions. No paid price, tax treatment, SLA, payment provider, public signup, automatic purge or real charge is authorized by this document. Pricing/terms/privacy and seller identity must be approved first.

## P04-01 — commercial catalog and subscription state

Extend Phase 1's immutable plan versions with currency, effective prices, billing period and accepted terms version. Proposed capacity configurations for implementation fixtures: Free 5 employees/1 branch/0 devices; Starter 20/1/1; Growth 50/3/5; Business 100/10/10; Scale 250/20/20. These are working quotas for product approval, not advertised promises. Core security, backups and historical export exist in every plan. Advanced modules remain unavailable until implemented.

Launch feature baseline: Free includes employee records, basic onboarding/offboarding, standard documents, self-service, leave, manual/CSV attendance and basic reports, but not device ingestion or payroll. All paid packages add supported K50 ingestion, reviewed payroll/payslips and their standard reports/approvals; initial paid differences are capacity rather than invented unavailable advanced functionality. Expense/asset capabilities are absent from all launch packages until Phase 5 terms are approved. A complimentary grant may enable a paid package's features at zero collection. Connector count is limited to one enrolled active connector per allowed device initially; one connector may serve multiple assigned devices within a tenant, and replacement retires the previous device-reader lease.

Separate capability package, capacity grants, billing mode (`free`, `manual_paid`, `complimentary`, later `provider_paid`), invoice state and tenant security state. Subscription states: `draft`, `trial`, `active`, `grace`, `restricted`, `cancelled`. An overdue invoice may be marked `past_due` independently; it does not automatically prove that an otherwise prepaid subscription has expired. Trial duration must be an approved catalog value; no implicit unlimited trial.

Working renewal policy for approval: paid service is active through `paid_through`; after expiry grant seven calendar days of commercial grace with reminders. Then enter restricted service. Cancellation at period end preserves prepaid access; immediate cancellation/revocation requires an explicitly authorized operation. Use server time, dates/terms recorded in the subscription and idempotent scheduled transitions.

Action policy by state:

- Active/trial/grace: authorized historical read/export, existing employee/device operations and payroll within entitlements. Grace shows warnings and a clear end date. New paid obligations still require consent.
- Restricted/cancelled: preserve authorized historical read/export and billing recovery for a proposed 30-day access window; disable new employee activation, new payroll calculations/finalization and ordinary new processing. Device ingestion returns an explicit non-acknowledgment policy code so the connector retains unaccepted backlog within its tested capacity. Alert HR before and after suspension; explain that backlog retention is finite. Previously accepted events remain stored.
- Security suspension: deny normal customer/machine access regardless of commercial state; only an approved secure recovery/export process can operate.

Grant expiry may fall back to Free only if capacities fit and the customer was informed; otherwise use the approved grace/restricted process. Never auto-charge a complimentary client without an accepted paid agreement. Expired feature grants preserve authorized historical records. Revocation and expiry update the effective-entitlement version and all relevant action checks, including workers.

Acceptance: time-travel tests cover period boundaries, grace expiry, repeated scheduler runs, security suspension and reactivation; complimentary access has zero collection without disabling tenant/role rules. Restriction does not destroy data or falsely acknowledge discarded device events. Users see the exact actions/retention limits that will change before expiry.

## P04-02 — invoices, manual payments and plan changes

Create versioned PKR price records only after product/finance approval. A missing price or invoice-tax configuration blocks issue; no fake zero-price paid invoice or assumed tax rate. Invoice lifecycle: `draft → issued → partially_paid/paid/past_due`, with void/credit states preserving the original financial record. Use a reviewed unique numbering scheme and immutable issued lines, dates, identity and tax treatment.

Manual collection: finance issues invoice; customer can submit a payment reference/proof; a platform finance approver verifies actual settlement and records an allocation. Proof upload alone never activates service. The same operator cannot approve their own manual payment entry. Protect proofs through the shared private-file pipeline. Record amount/currency, value date, account/reference digest, invoice allocation, recorder, approver and evidence reference. Prevent duplicate allocation; overpayments become explicit credit, not extra months inferred by a client request.

An approved paid allocation can extend subscription `paid_through` under the accepted contract. Payment, entitlement transition, audit and outbox commit consistently; replay produces one extension. Refunds/credits require reason/approval and do not delete original payments. Distinguish accounting records from actual money movement—v1 records externally verified transfers and does not execute bank refunds.

Upgrades: preview effective capabilities/capacity and an explicit quote; apply immediately only after accepted commercial terms and required payment or an authorized dated grant. Any proration/credit is itemized and approved, not an undocumented formula. Downgrades: schedule at renewal, recheck employee/branch/device usage and block a downgrade that does not fit; request customer resolution rather than deleting records or devices. Archived employees do not count, but history remains. Notification retries do not duplicate invoice issue or plan changes.

Acceptance: one payment reference cannot pay twice through replay/concurrent approval; uploaded proof is not marked paid; unpaid draft quote does not unlock a paid module; the 21st employee remains blocked on Starter; downgrade below usage waits for resolution; complimentary-to-paid requires consent. Invoice totals reconcile to lines/credits and actual verified allocations.

## P04-03 — optional automated collection adapter

Proceed only after E06 provider eligibility and sandbox approval. Define provider-neutral customer/subscription/invoice/payment references without making provider state the entire authorization model. Use hosted checkout; no card data reaches our servers. Checkout return URLs only display pending status, never activate access.

Verify webhook signature over the required raw body, enforce provider timestamp/replay rules and persist a unique provider event ID before processing. Acknowledge only after durable receipt. Reconcile authoritative provider state for out-of-order/missed events; use idempotent business keys for entitlements and payments. Minimize provider payload retention and redact logs. Map failed collection, partial payments, refunds and cancellations to the documented internal state machine.

Acceptance: invalid signature fails; duplicate/out-of-order webhook and browser-success spoof do not create access; missed webhook is recovered by reconciliation; worker failure resumes safely; sandbox cancellation/refund results reconcile. Disable this adapter entirely if eligibility or these tests are absent. Approved manual renewal is still a valid release path and must be described honestly to customers.

## P04-04 — security, performance, recovery and operations

Run the shared-spec benchmark with recorded versions/host, actual metrics and reproducible fixtures. Record API latency, queue age, 250-employee payroll/import duration and connector recovery. Fix unacceptable results or revise unpromised targets with product/operator approval before marketing claims. Tenant isolation cannot be waived to meet a performance target.

Review cross-tenant reads/writes/files/jobs/exports, privileged MFA, CSRF/session behavior, restricted fields, mass assignment, upload handling, secrets/dependencies and operator support grants. No unresolved critical/high security defect, data-loss defect or unexplained monetary discrepancy can pass release. Dependency exceptions require documented risk ownership and may not waive those blocker categories.

Prove database point-in-time recovery, object-file recovery, identity/configuration recovery and one-tenant export/recovery in an isolated environment. Measure actual RPO/RTO against targets; recovery must not expose another tenant or send replayed invoice emails/payment actions accidentally. Restore jobs begin with outbound side effects disabled until reconciled. Reconcile duplicate financial/device events after restore using stable business identities.

Deliver operator runbooks for incident triage, broken K50 sync, payroll discrepancy, failed job replay, failed collection, credential compromise, backup/restore, deployment rollback, customer export/offboarding and data-retention/legal hold. Assign real contacts/escalation and support hours before public claims. Monitoring covers availability, queue age, device silence/backlog, failed backups, exceptional payroll and billing reconciliation; avoid PII in metrics labels.

Acceptance: a second operator can perform the restore and incident drills from instructions; the measured recovery meets the approved target; alerts are triggered and received in a test; support access is explicitly approved, time limited and audited. Security and privacy/customer agreements are accepted for the intended launch scope.

## P04-05 — pilot reconciliation and controlled launch

For each launch payroll policy category, reconcile two consecutive live monthly cycles in parallel with the existing approved payroll. Record input versions, every difference, cause, correction, reviewed final figures and customer approval. Historical replay supplements but cannot replace live cycles. Do not use a fabricated acknowledgment or model-generated sign-off as customer approval.

Complete the end-to-end journey: create company → assign plan/complimentary grant → import employees → connect authorized K50 → review leave/attendance → lock period → calculate/review/finalize payroll → publish slips/export → record verified payments → renew/restrict/reactivate subscription. Distinguish salary-payment records from SaaS subscription payments in UI/data.

Launch by tenant allowlist, with feature flags independent of entitlements and a rollback window/owner. Start with the validated customer/device/rule scope; document unsupported cases and support contacts. No public self-serve signup until abuse controls, onboarding terms and automated provisioning are separately approved and tested. Test contract-approved export/access restrictions before enforcing them on paying customers.

Acceptance: product owner, payroll specialist, customer payroll approver, security reviewer and operator explicitly accept their gates. All required phases and work packages pass, except P04-03 may be marked deferred with manual renewal clearly selected. Announce only features, supported hardware and service targets actually demonstrated.

## Schema, API and screens

Add `price_versions`, `subscription_terms_acceptances`, `subscription_transitions`, `invoices`, `invoice_lines`, `payment_submissions`, `subscription_payments`, `payment_allocations`, `credit_notes`, `plan_change_quotes`, `scheduled_plan_changes`, `billing_provider_events`, `renewal_notifications` and `release_approvals`. Immutable issued invoice and payment references must survive retries and restore. Distinguish these from Phase 3 salary payments; tenant foreign keys/RLS apply to commercial records accessible by customers, and finance mutation uses restricted platform roles.

Tenant routes: `/billing/subscription`, `/billing/usage`, `/billing/invoices`, `/billing/payment-submissions`, `/billing/plan-change-quotes`, `/billing/plan-changes`, `/billing/cancellation`, and `/billing/exports`. Platform routes under `/api/v1/platform`: `/invoices`, `/payment-submissions/{id}/approve`, `/subscription-payments`, `/tenants/{id}/subscription-transitions`, `/tenants/{id}/grants`, `/support-grants`, `/health` with only safe technical metadata. Optional absolute `/api/v1/billing/providers/{provider}/webhooks` uses provider authentication, not tenant cookies.

Financial commands use POST and durable business references. A payment submission contains invoice ID, claimed amount/currency, transfer reference/date and a clean proof-document ID; approval references independently verified settlement and expected submission version. A plan-change acceptance references quote ID/version and terms version, never arbitrary price/capacity values. Customer endpoints cannot directly set invoice state, paid-through, complimentary mode or grant contents.

Screens: owner plan/usage/renewal page, invoice/payment-proof history, upgrade/downgrade preview, grace/restriction notices, platform finance approvals, grant history, device/queue health, customer export and controlled support-access request. Do not render MRR from complimentary accounts or count an issued unpaid invoice as collected cash.

## Rollback and retained access

Rollback releases with flags and compatible app images. Preserve invoices, ledger allocations, accepted raw events and finalized payroll. Freeze affected transitions/collections when reconciliation fails, and repair through compensating audited operations. Never attempt to undo a real external payment with a database rollback. Downtime must not be hidden by resetting availability metrics or changing paid-through dates without a reason.

## Implementation record

- Work packages: P04-01 through P04-05 — not started; P04-03 conditional on provider decision.
- Live payroll cycles accepted: zero.
- Billing approvals, benchmark/security/recovery results: none yet.
- Production release/paid hosting/payment authorization: not granted by this specification; approval pending.
