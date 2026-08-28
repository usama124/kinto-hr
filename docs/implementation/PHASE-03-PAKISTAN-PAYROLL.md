# Phase 3 — Pakistan payroll pilot

Version 1.0 · 28 August 2026 · Status: not started · Estimate: 4–6 weeks; live-cycle review may take longer

Dependencies: [Phase 2](PHASE-02-ATTENDANCE-LEAVE.md), reviewed P00 payroll inventory/fixtures, [shared spec](SYSTEM-SPEC.md). Next: [Phase 4](PHASE-04-COMMERCIAL-RELEASE.md).

## Objective, entry and scope

Calculate explainable PKR monthly payroll for the approved Pakistan employer/employee categories. Supply immutable reviewed payroll, payslips and exports without transferring funds. The payroll preparer, independent approver and specialist are essential actors. Unknown applicable tax/contribution rules, unreviewed opening balances or missing attendance snapshots block real finalization.

Include monthly salaries, effective salary changes, fixed allowances, authorized one-off bonus/deduction, approved overtime, unpaid leave/proration, validated applicable statutory rules, advances/loans with reviewed schedules, and reviewed final settlement. Defer hourly/piecework payroll, arbitrary scripts, multiple currencies, direct bank payouts and tax-authority filing. Customer contracts must state unsupported categories; do not market a generic engine as universal Pakistan compliance.

## P03-01 — compensation, rule packages and opening balances

Model effective-dated compensation agreements with currency, base salary and typed components. A component identifies earning/deduction/employer contribution/reimbursement, recurrence, formula kind, taxable/contribution treatment and applicable rule references. Separate employer contributions from deductions to employee net pay. Permit fixed amount, percentage of an explicitly named base, approved quantity × reviewed rate, and narrowly specified statutory calculators. No arbitrary JavaScript, SQL or customer-authored executable expression.

Compensation changes require payroll permission, source/reason and effective date, reject overlapping periods and trigger stale-input detection for affected unfinalized runs. Mask amounts for ordinary HR/manager users. Import opening YTD totals and prior payments/deductions with as-of date, source totals and independent review; do not infer zero merely because the customer joined mid-year.

Rule package fields: jurisdiction/employer category, employee applicability, effective start/end, source reference/digest, calculation version, inputs, boundaries, precision/rounding, reviewed fixtures, reviewer and publication status. States `draft → reviewed → published → retired`; retired packages remain readable for historical calculations. Never edit a published package in place. A published package requires specialist approval, not only an admin toggle.

Rule maintenance/review/publication require separately assigned `payroll.rules.manage`, `payroll.rules.review` and `payroll.rules.publish` permissions; ordinary preparer/approver roles do not imply them. A package author cannot be its independent reviewer. Record the specialist's review identity/evidence even when a permitted operator publishes the reviewed package on their behalf.

Acceptance: future increases do not change past salary snapshots; missing applicable rule/opening balance blocks finalization with a specific error; rule publication cannot bypass reviewer evidence; different effective periods select the correct package. A verified exemption is explicit policy data, not an absent rule.

## P03-02 — deterministic calculation and input snapshots

Create a pay period for the legal entity with start/end, pay date, payroll-policy version and expected participant list from all overlapping employment periods, including legitimate leavers. A worker without a login remains included. Missing salary/attendance/policy data is an exception, not a silent exclusion.

Before calculation, require a locked attendance snapshot, reviewed compensation/one-off inputs and approved rule packages. Build an immutable input snapshot and hash covering employee participation, effective salary slices, leave/payable segments, approved overtime, one-off items, loan schedule, opening YTD, rule versions, proration and rounding. Track a tenant payroll-input revision incremented transactionally by relevant mutations; stale revision blocks review/finalization and forces a fresh snapshot. Conservative invalidation is acceptable initially; silent stale pay is not.

Calculation pipeline: validate inputs → split employment/compensation periods → determine payable/unpaid units once → prorate components using reviewed basis → add approved earnings/overtime → apply statutory calculations in the reviewed dependency order → apply authorized deductions → total employee net and employer cost → validate/reconcile → persist output revision. Do not assume one universal order or tax base; the reviewed rule package defines dependencies, annualization and rounding.

Do not double-deduct a day as both approved unpaid leave and absence. Raw late minutes do not become a deduction without a separately reviewed lawful policy. Missing punches remain blocking exceptions until resolved. Reject negative net pay for v1 rather than silently reducing a deduction or creating debt; a reviewed adjustment is required. Loans/advances have distinct issuance, repayment schedule and recovery postings; payroll finalization posts each due recovery once and a compensating adjustment handles reversals.

Each line retains component, quantity, rate, base, source IDs, rule version, intermediate/rounded values and an explanation. Totals show earnings, employee deductions, employer contributions, reimbursements, net pay and employer cost separately. Test deterministic output from identical versioned input. Decimal precision and rounding follow shared contracts.

Synthetic fixture, **not a Pakistan statutory rule**: under an expressly configured 30-day divisor, PKR 60,000 base with one unpaid day and no other components yields a PKR 2,000 deduction and PKR 58,000 net. Half a day yields PKR 1,000 deduction. This tests engine arithmetic only; production tax/contribution calculations require independently reviewed fixtures.

Acceptance: independently prepared fixtures reconcile every line and total to the declared rounding; worker retry yields the same result/revision without duplicate recoveries; overlapping leave/absence is charged once; mid-period increase splits correctly; excluded participants and missing inputs are visible errors. No unexplained difference is accepted as a tolerance.

## P03-03 — run review, approval and immutable finalization

Run lifecycle: `draft → calculating → calculated → reviewed → approved → finalized`. Calculation failure becomes a recoverable failed attempt under the draft run; a new attempt must not expose partial results as final. Input changes or recalculation invalidate prior review/approval and require a new revision. Record checks and decisions against an exact input/output hash.

Review screen shows roster completeness, blocking exceptions, per-employee breakdown, totals, change from previous period and flagged large changes using an employer-configured threshold. A change flag requires acknowledgment; it is not evidence of wrongdoing. Reviewer cannot edit source inputs from an approval action. The preparer cannot approve their own run; finalization requires an eligible approver, recent MFA/reauthentication and explicit confirmation of totals and participant count.

Finalize within a transaction locking the run/period and relevant attendance lock: recheck role, tenant/entitlement state, input revision, approval hash, participant coverage and all blockers. Persist immutable inputs/results, finalization audit, recovery postings and output outbox together. Enforce only one finalized regular payroll per employee/legal-entity/pay period; adjustments are explicitly distinct. Business uniqueness survives idempotency-key expiry. Concurrent finalization or replay yields one completed run.

Finalized records cannot be edited/deleted through ordinary APIs. Correct them via a linked adjustment run containing original line references, deltas, reason, revised statutory treatment where necessary and its own independent approval. Do not automatically recalculate historical finalized runs when a rule changes. A void/reversal is an auditable compensating process, not a status flip that erases paid obligations.

Acceptance: stale approvals fail; simultaneous finalization produces one final result; re-opening attendance cannot race past finalization; self-approval fails even with combined roles; finalized payslip input/output hashes remain unchanged after later compensation/policy changes; adjustment links preserve both original and correcting amounts.

## P03-04 — payslips, exports and payment records

Generate private PDF payslips from finalized snapshots, with employer/employee identification appropriate to policy, pay period, line explanations, totals and document version. PDF generation is asynchronous; finalization does not depend on a PDF renderer being healthy. Publication is a separate explicit batch action only after all required documents validate. Employees can access their own published payslips; approvers can access the permitted payroll set. Emails contain a link, not salary details.

Produce a payroll register and generic bank-payment CSV first. A bank-specific file format is enabled only after its schema/sample is validated with that bank/customer. Validate beneficiary completeness and totals before export; generated files remain immutable, restricted and checksummed. Re-downloading the same export is allowed; creating a new export is auditable and must not imply another payment instruction was executed.

Payment status is separate: `unrecorded`, `partially_recorded`, `recorded`, `disputed/reversed` according to documented reconciliation. Record confirmed amounts, date, method, external reference, payer/approver and evidence. Generic export never changes status to paid. Duplicate external references/business payment keys are rejected; sum of recorded amounts cannot exceed the approved payable amount without a specific approved correction. No API transfers money in v1.

Final settlement uses reviewed termination dates, payable components, outstanding advances and applicable employer rules. Unsupported settlement obligations block completion. Offboarding tasks cannot erase salary obligations or documents. Phase 5 asset clearance will be an advisory dependency; it must not create an automatic wage deduction.

Acceptance: employee A cannot obtain employee B's PDF even within one tenant; export totals equal finalized net payable; repeated export/renderer failure does not duplicate payroll; payment evidence is distinct from export completion; final settlement fixtures reconcile with the independent reviewer. Visually inspect payslip PDFs for long names, multiple lines, page breaks and privacy before release.

## P03-05 — payroll validation and shadow pilot

Run the P00 independent corpus, boundary/property tests and historical replay with authorized data. Cover joining/leaving mid-month, leap/calendar boundaries, effective-date changes, paid/unpaid half-days, holidays, overtime, advances, negative-net rejection, salary changes, YTD tax adjustments and final settlement under each supported published rule package.

Run scoped permissions, worker crash/replay, stale input, concurrent finalize, unauthorized adjustment and migrated opening-balance tests. Record expected/actual line values, discrepancy reasons, correction and reviewer signature. Test a full employee/import → attendance → leave → payroll → publication → payment-record journey.

Begin supervised live shadow payroll only after specialist approval and privacy gates. Existing payroll remains authoritative. Phase 4 requires two consecutive live monthly cycles reconciled and accepted by the employer; historical replay alone cannot satisfy that gate. Phase 3 can finish its engineering acceptance while the live-cycle record is still in progress, but cannot authorize commercial payroll release.

Acceptance: every supported independent fixture and authorized historical replay reconciles with no unexplained difference; permission/retry/finalization tests pass; the specialist accepts rule coverage and results; the customer approves the supervised shadow-pilot procedure. Record live-cycle status accurately and carry incomplete live-cycle acceptance into Phase 4 as a release blocker.

## Schema and migrations

Entities: `compensation_agreements`, `salary_components`, `compensation_component_versions`, `payroll_policy_versions`, `statutory_rule_packages`, `rule_reviews`, `payroll_opening_balances`, `payroll_periods`, `payroll_runs`, `payroll_run_attempts`, `payroll_input_snapshots`, `payroll_result_lines`, `payroll_approvals`, `payroll_adjustments`, `loan_accounts`, `loan_schedules`, `loan_recovery_postings`, `payslip_documents`, `payroll_exports`, `salary_payment_records` and `payroll_input_revisions`.

All employment/component/run/document references include tenant. Compensation/rule intervals reject overlap for identical applicability. Finalized regular-pay uniqueness is enforced in persistent employee-period finalization records, not just a queue job key. Inputs/results of a finalized revision are immutable to ordinary runtime updates. Migration from earlier phases must not alter locked attendance snapshots or silently create zero opening balances.

Worker events: `payroll.calculation_requested.v1`, `payroll.calculation_completed.v1`, `payroll.finalized.v1`, `payslip.render_requested.v1`, `payslip.published.v1`, `payroll.adjustment_requested.v1`. Events carry IDs/hash/version, never salary payloads.

## API and UI contracts

Tenant routes: `/payroll/compensation`, `/payroll/components`, `/payroll/rule-packages` and `/payroll/rule-packages/{id}/review`/`publish`, `/payroll/opening-balances`, `/payroll/periods`, `/payroll/runs`, `/payroll/loans`, and `/me/payslips`. Run-scoped POST commands use `/payroll/runs/{id}/calculate`, `/payroll/runs/{id}/review`, `/payroll/runs/{id}/approve`, `/payroll/runs/{id}/finalize`, `/payroll/runs/{id}/adjustments`, `/payroll/runs/{id}/payslips/publish`, `/payroll/runs/{id}/exports` and `/payroll/runs/{id}/payment-records`.

Calculate accepts run version and the selected locked attendance snapshot ID; review/approve/finalize require run version, input/output hash and decision reason as applicable. The server selects/validates authoritative salary/rule inputs; the request cannot submit trusted net amounts. Adjustment creation supplies original finalized run/line references and proposed reviewed inputs, never overwrites the original. Calculation returns 202 and a job ID; finalization returns the existing finalized result on an identical idempotent retry.

Screens: compensation history, approved rule package/applicability, opening balance review, period setup, calculation progress, exceptions, side-by-side period changes, line-level explanation, approval/finalization confirmation, payslip publication and payment reconciliation. Reports: payroll register, employer costs, employee deductions/contributions, final settlement and payroll audit. Do not expose invented tax values for incomplete rule packages.

## Rollout and rollback

Enable payroll per approved pilot tenant and rule package; never globally enable every Pakistan employer. Disable new calculation/finalization if a defect appears, preserve previously finalized outputs, investigate affected snapshots and issue reviewed corrections. Rolling code back must keep readers compatible with issued payslips and stored calculation versions. Never fix a discrepancy by directly editing finalized database amounts.

## Implementation record

- Work packages: P03-01 through P03-05 — not started.
- Published rule approvals and independent fixture evidence: none yet.
- Code, tests, PDF inspection and reconciliation results: none yet.
- Live shadow cycles: zero completed; commercial approval pending Phase 4.
