# Phase 0 — validation and implementation readiness

Version 1.1 · 28 August 2026 · Status: partial architecture spike locally verified · Estimate: 2–3 weeks, external waits excluded

Dependencies: [shared spec](SYSTEM-SPEC.md), [decisions](DECISIONS.md). Next: [Phase 1](PHASE-01-PLATFORM-PEOPLE.md).

## Objective and boundaries

Replace the highest-risk assumptions with evidence before committing to a production scope. This phase produces a supported-scope dossier, hardware proof, payroll fixture pack and architecture decisions. It does not deliver a customer-ready application, authorize live payroll or purchase hosting.

Entry: confirmed Pakistan/K50 requirements and this specification package. Interviews and real hardware/payroll work require an authorized customer contact. Missing access blocks the corresponding evidence, not document preparation or isolated synthetic spikes.

## P00-01 — pilot scope and user journeys

Interview the product owner and 5–10 prospective employers where practical; secure 2–3 willing pilot employers before commercial pilot commitments. Record employer province/territory, industry, headcount, branches, pay frequency, worker categories, shifts, approval staff, migration source and current payroll process. Confirm the working scope or document deviations.

Write the happy path and exceptions for company setup, employee import, attendance collection, leave approval, missing-punch correction, monthly payroll, complimentary access and subscription renewal. Collect only authorized/anonymized samples and no production credentials in documents. Name the HR owner, payroll reviewer and pilot approver.

Acceptance: each included workflow has inputs, responsible actor, expected output and a known source of truth; unsupported hourly/piecework or employer categories are explicitly excluded. Privacy permission E03 is recorded before using real data. Product owner approves the supported-scope record.

## P00-02 — K50 read-only integration proof

Record exact physical model/variant, firmware, host OS/architecture, network topology, time settings, current attendance software and vendor SDK/API documentation. Obtain authorized SDK access and evaluate redistribution terms; never download/bundle undocumented binaries as a substitute for vendor permission.

A small isolated adapter must connect to the authorized device, read device identity and attendance events, preserve source fields and map a sample employee. Start read-only: do not clear logs, upload fingerprints, change firmware/clock, disable the reader or interfere with existing software. If a documented read method would temporarily disable the device, obtain a separate maintenance approval first.

Repeat reads, disconnect/reconnect, restart the connector and test known duplicate/out-of-order events. Use a dedicated test unit or approved maintenance window for device power tests. Record event counts and identifiers before/after; distinguish synthetic replay from actual hardware tests. Investigate whether stable event IDs, direction and incremental cursors exist. Do not assert a port, polling protocol, ADMS or HTTPS capability without evidence.

Acceptance: one documented K50/firmware combination produces matching source and imported event counts; repeated reads do not duplicate normalized events; interrupted upload/replay loses no events in the test corpus; timestamp interpretation is demonstrated. If the device cannot distinguish identical events, document that limitation and require ambiguous cases to be flagged rather than silently dropped. Record SDK/runtime choice, supported host, operating limits and coexistence findings. Direct push is optional future scope.

## P00-03 — Pakistan payroll policy and independent fixtures

With a qualified local payroll specialist, inventory employer-specific pay components, proration basis, leave treatment, overtime, applicable tax/contributions, final settlement, annual/YTD calculations and mid-year opening balances. Record jurisdiction, effective dates, authoritative source, reviewer and supported employee categories for each rule. Sources must be effective for the pay period; a historical rate card is not a current rule.

Create independently calculated expectations for at least: normal month; joiner; leaver; unpaid day/half-day; salary change; approved overtime; allowance/bonus; deduction/advance; rounding boundary; tax-rule boundary; YTD adjustment; and final settlement. Include raw inputs, every expected line, totals, expected errors and reviewer approval. Synthetic nonstatutory engine examples are separately labeled and cannot count as legal/payroll sign-off.

Acceptance: all supported scenarios have independent expected results and rule applicability is explicit. Missing tax/contribution data is a blocking condition, not a default zero. Employer and specialist approve the rule inventory; no production finalization until Phase 3 implements and verifies it.

## P00-04 — architecture and integration spikes

Select supported runtime/dependency versions and prove the web/API/worker/database toolchain locally. Test Prisma transactions plus tenant RLS on pooled connections using two tenants, missing context, concurrent traffic, rollback and job execution. Demonstrate an OIDC login/session with the intended MFA evidence path and no browser-stored long-lived tokens.

Prove a database outbox plus repeated consumer delivery yields one business effect. Test a private file upload/download authorization boundary. Record SDK and dependency licenses, local service requirements, intended production services/region and a cost estimate for recovery targets. A failed ORM/RLS spike permits a reviewed access-layer change, not removal of isolation controls.

Acceptance: selected versions and commands are reproducible from a clean local environment; tenant/identity tests pass; dependencies and hosting decisions are documented. No production secrets, paid resources or public routes are required. Version choices are recorded before scaffolding is treated as the production baseline.

## P00-05 — scope freeze and executable backlog

Resolve applicable decisions E01–E09 or record exactly which future capability remains gated. Confirm work-package ordering and re-estimate using actual staffing and integration findings. Specify migration templates and account owner for manually invoiced subscriptions. Record a deployment/security and independent payroll reviewer for later phases.

Acceptance: product owner approves MVP inclusions/exclusions; engineering accepts contracts; owners accept external gates. Any safe work permitted while hardware/payroll evidence is missing is explicitly identified. Do not call the full phase complete if a required proof is missing.

## Artifacts and evidence

When executed, store sanitized evidence under `docs/evidence/phase-00/`: scope record, K50 compatibility record and replay results, reviewed payroll fixture manifest, architecture/version decisions and costed operating assumptions. Restricted customer documents belong in an approved private location; use references/digests in the repository, not their contents. The folder and its results are future deliverables, not supplied by this planning phase.

## Exit and rollback

All five work packages meet acceptance; the product owner and engineering reviewer accept scope, device proof and platform choices; the payroll specialist accepts the fixture/rule inventory. No production deployment occurs. Remove isolated test credentials when trials finish. Roll back prototype infrastructure without touching customer device logs or business records. Preserve sanitized findings so a failed integration is not repeated blindly.

## Implementation record

- Work packages: P00-04 partially implemented and locally verified; P00-01/02/03/05 remain open.
- Code/commands executed: pinned toolchain, web/API build, real PostgreSQL RLS/pool/rollback and capacity concurrency checks. See [foundation evidence](../evidence/phase-01/foundation.md).
- Evidence still missing: real K50/SDK compatibility, independent payroll fixtures, OIDC/MFA, worker consumer replay, private files, deployment costing and dependency-license review. No full P00 acceptance is claimed.
- Known external gates: device access/firmware, pilot policies and independent payroll reviewer, hosting/billing approvals.
- Review and sign-off: pending; specification creation is not phase acceptance.
