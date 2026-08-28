# Phase 5 — expenses and asset custody

Version 1.0 · 28 August 2026 · Status: not started · Estimate: 4–6 additional weeks after stable launch

Dependencies: [Phase 4](PHASE-04-COMMERCIAL-RELEASE.md), existing permissions/files/approvals/payroll contracts and [shared spec](SYSTEM-SPEC.md).

## Objective, entry and explicit limits

Add two bounded modules that reuse the trustworthy core: employee expense claims and company asset assignment/return. Entry requires commercial release acceptance, named pilot demand and no unresolved critical production defect. Product owner confirms prioritization and pricing before work starts; modules are opt-in and unavailable until their own acceptance passes.

This is not a promise to build every HR feature in one phase. Recruitment/ATS, performance management, training, advanced shifts, native mobile, additional countries, dedicated hosting and on-premises licensing each need a separate scoped specification and approved business case.

## P05-01 — module permissions and rollout controls

Add separate `expenses` and `assets` capabilities, permission scopes and feature flags without changing existing subscriptions silently. Company owners can assign module-specific roles; an expense approver does not gain payroll salary access. Reuse employee identity, reporting lines, private file scanning, audit and notification mechanisms rather than creating parallel versions.

Migrate existing tenants with both modules disabled; create no synthetic assets/claims in production. Selected pilot tenants receive dated grants with explicit terms. On disabling a module, preserve authorized historical read/export and reject new work; do not delete records.

Acceptance: entitlement-disabled APIs fail even if UI routes are guessed; a manager sees only granted team claims/assets; default rollout changes no existing payroll/attendance totals; downgrade preserves history.

## P05-02 — expense claims and approvals

Employees create PKR claims with expense date, category, amount, purpose, cost center/branch and scanned receipt where policy requires. All amounts use decimal strings. Configure category limits, receipt threshold and required approver; no currency conversion or card feeds in v1. Flag probable duplicates using employee/date/amount/receipt hash for human review, but do not globally search customer receipts or auto-reject on a heuristic alone.

Workflow: `draft → submitted → approved/rejected → scheduled_for_reimbursement → reimbursed`. Submitted claims freeze their item revision; a change requires withdrawal/resubmission, invalidating approval. No self-approval. Rejected/withdrawn claims retain audit history. Cancellation after scheduling requires coordinated reversal; reimbursed claims require a correcting record rather than delete.

Approve the amount and approved reimbursement method independently of the submission. Payment may be externally recorded with evidence, or sent once as a reviewed payroll reimbursement input. The selected method and unique reimbursement allocation prevent both paths paying the same claim. Tax treatment is determined by an approved applicable rule, never automatically assumed tax-free.

Acceptance: concurrent/repeated approval creates one obligation; edited receipt/amount invalidates approval; unscanned receipt cannot be read; cross-employee claim access fails; duplicate reimbursement to payroll/external payment is prevented transactionally; unsupported tax treatment blocks payroll inclusion.

## P05-03 — payroll reimbursement handoff

An approved claim selected for payroll generates a unique input reference linked to a target unfinalized run. Snapshot claim revision, approved amount and treatment. It increments the payroll-input revision and invalidates stale approval. When payroll finalizes, mark the claim allocated to that immutable run; mark reimbursed only when the associated salary payment is actually recorded/reconciled. Finalized/paid corrections use linked adjustments; no new automatic payout is attempted.

If a run is abandoned before finalization, release the allocation once with an audit reason so another run or external process can take it. Reject attaching a claim to two active/finalized reimbursement paths. An unavailable expense module cannot silently remove already snapshotted obligations from payroll history.

Acceptance: failed worker/retry never doubles reimbursement; stale payroll approval fails after a claim is included; export alone does not mark the claim reimbursed; finalized correction preserves the original claim/run link. Existing Phase 3 fixture results remain unchanged when no expense inputs exist.

## P05-04 — asset registry, custody and returns

Asset fields: tenant asset tag, category, serial where available, description, acquisition date/cost if authorized, branch, condition and status. No depreciation/accounting engine. Status: `available`, `assigned`, `maintenance`, `lost`, `retired`. Custody assignments retain employee, issue date, expected return, acceptance, condition and attachments.

Assign only an available asset to an active eligible employee under a transaction/unique active-assignment constraint. Transfers close previous custody and create new custody in one transaction. Return records condition, receiving actor, date and employee acknowledgment/dispute. Lost/damaged status requires reason and approved incident record; it does not authorize a salary deduction.

Offboarding surfaces outstanding assets as clearance tasks. Final settlement reviewers can see clearance status with appropriate access, but the system does not automatically withhold wages or deduct asset value. Any recovery must follow a separately approved applicable policy and payroll adjustment process. Employee termination cannot delete outstanding custody.

Acceptance: two simultaneous assignments of one asset produce one success; an asset cannot be assigned across tenants; lost/maintenance/retired assets are unavailable; transfer/return history is preserved; a terminated worker's unresolved custody remains visible; damage/loss does not change net pay automatically.

## Schema, APIs and screens

Entities: `expense_policy_versions`, `expense_claims`, `expense_items`, `expense_receipts`, `expense_decisions`, `reimbursement_allocations`, `expense_payment_records`, `assets`, `asset_custody`, `asset_returns`, `asset_incidents` and `asset_clearance_tasks`. Tenant foreign keys, immutable approved revisions, one active reimbursement allocation per claim and one active custody per asset are database-enforced. Asset cost fields need restricted projections.

Tenant APIs: `/expenses/policies`, `/expenses/claims`, `/expenses/payment-records`, `/assets`, `/employees/{id}/asset-clearance`, `/me/expenses` and `/me/assets`. Claim POST commands are `/expenses/claims/{id}/submit`, `/expenses/claims/{id}/decision`, `/expenses/claims/{id}/withdraw` and `/expenses/claims/{id}/reimbursement-allocations`. Asset POST commands are `/assets/{id}/assign`, `/assets/{id}/transfer`, `/assets/{id}/return` and `/assets/{id}/incidents`. Commands inherit shared version/idempotency conventions. Event payloads contain IDs/revisions only; examples are `expense.approved.v1`, `expense.reimbursement_allocated.v1`, `asset.assigned.v1` and `asset.returned.v1`.

Screens: employee expense/receipt entry and status; approver queue; reimbursement reconciliation; asset list/detail/custody history; assignment/return; employee asset view; offboarding clearance. Reports: claims by approval/payment status, approved outstanding reimbursements, current custody, overdue returns and lost/maintenance inventory. Label financial totals as claimed, approved, allocated or paid rather than one ambiguous expense total.

## Acceptance, deployment and rollback

Test every work package, tenant/role isolation, file safety, decimal amounts, self-approval, state races and worker replay. Run the full payroll regression suite with/without reimbursements. Pilot one complete claim-to-payment and asset issue-to-return lifecycle with customer approval; review accessibility and exports. Measure new queue/jobs against the existing system targets and confirm no payroll regression.

Deploy additive migrations then readers/writers behind independent feature flags; enable one pilot tenant before broader grants. Rollback disables new claims/asset mutations or reimbursement routing as appropriate, preserves approved financial obligations/custody, and uses explicit compensating actions. Do not remove a finalized payroll line to uninstall the module. Operator owns a support/reconciliation runbook for both modules.

## Implementation record

- Work packages: P05-01 through P05-04 — not started.
- Product prioritization, module pricing and pilot customer: pending.
- Code, regression/pilot evidence and rollout approval: none yet.
- Deferred modules: require separate specifications; not included in this phase's completion claim.
