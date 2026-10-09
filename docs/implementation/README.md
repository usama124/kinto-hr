# Implementation roadmap

Version 1.1 · 28 August 2026 · Status: foundation slice implemented; phases remain incomplete

This package converts the [product blueprint](../../PRODUCT-PLAN.md) into an execution plan. It retains phases 0–5; smaller work packages inside each phase are the units of implementation. These documents specify required production behavior, not a claim that anything has been built, tested, legally approved, or deployed.

## Confirmed scope and working defaults

Confirmed: Pakistan launch; ZKTeco K50 as the initial device target; employee management, biometric attendance and payroll; multiple customer companies; free, monthly paid and selected complimentary accounts.

Working defaults: cloud SaaS with a local attendance connector; PKR; Asia/Karachi; English initially; one legal employer per tenant; multiple branches; monthly salaried employees; an initial ceiling of 250 active employees per tenant. Prices, hosting region, supported provinces/employer categories and actual K50 firmware remain decisions, not confirmed facts. An enterprise request beyond the ceiling requires a new capacity test and contract.

Version 1 production includes staff lifecycle, basic onboarding/offboarding, leave, fixed/overnight shifts, K50 event collection, corrections and approvals, validated Pakistan payroll, payslips, exports, reports, server-enforced subscriptions, complimentary access, security, backup/recovery and operating procedures.

Confirmed clarification: a local LAN connector fetches K50 attendance and uploads it with retry and re-read deduplication. Authorized company/HR staff capture compensation during employee onboarding and effective-dated increments later. Monthly payroll is generated automatically on a configured company date, with reviewable/downloadable reports; employers pay salaries entirely outside Kinto. Working default: generation on the 1st/10th is for the previous calendar month. See C05–C07/D08 in [decisions](DECISIONS.md); automatic generation does not bypass missing-input checks or finalization approval.

Outside version 1: international payroll; hourly/piecework payroll; ATS/recruitment; performance scoring; native mobile applications; GPS/face recognition attendance; arbitrary payroll scripts; bank payouts; direct tax filing; multiple legal employers in one tenant; dedicated/on-premises deployment. Phase 5 adds expenses and assets only after release stability. Other expansion remains a separate approval, not an implied commitment.

## Reading order

1. [Shared system specification](SYSTEM-SPEC.md): architecture, access, API/data contracts, operating targets and definition of done. Applies to every phase.
2. [Decision and evidence register](DECISIONS.md): defaults, external dependencies, owners and approval gates.
3. [Phase 0 — validation](PHASE-00-VALIDATION.md): hardware, payroll and architecture proof points.
4. [Phase 1 — platform and people](PHASE-01-PLATFORM-PEOPLE.md): repository, authentication, tenancy, entitlements and employee management.
5. [Phase 2 — attendance and leave](PHASE-02-ATTENDANCE-LEAVE.md): K50 connector, raw events, attendance policies, leave and approvals.
6. [Phase 3 — Pakistan payroll](PHASE-03-PAKISTAN-PAYROLL.md): validated calculations, immutable runs, approvals, payslips and export.
7. [Phase 4 — commercial release](PHASE-04-COMMERCIAL-RELEASE.md): subscriptions, collection, support, hardening and pilot release.
8. [Phase 5 — expenses and assets](PHASE-05-EXPENSES-ASSETS.md): bounded post-launch expansion.

## Dependency and release sequence

```mermaid
flowchart LR
    V[Phase 0: validation] --> F[Phase 1: platform and people]
    F --> T[Phase 2: attendance and leave]
    T --> P[Phase 3: payroll pilot]
    P --> L[Phase 4: commercial launch]
    L --> G[Phase 5: expenses and assets]
```

The diagram is the default acceptance sequence, not a requirement to leave engineers idle. Safe preparatory work such as repository scaffolding and synthetic fixtures may proceed while external Phase 0 evidence is pending, once its architecture decisions are recorded. Do not mark Phase 0 complete, advertise K50 compatibility, enable real payroll finalization or onboard live customers by substituting mocks for missing evidence.

Billing work in Phase 4 can be developed alongside payroll after Phase 1 contracts are stable. The commercial release still requires all preceding release gates. Security and backups start in Phase 1; Phase 4 verifies and hardens them rather than introducing them for the first time.

## Phase ledger

- **P00 — in progress (partial architecture spike); 2–3 estimated weeks.** Exit: approved supported-scope record, K50 evidence, selected integration/auth/deployment approach and independent payroll fixtures. Allowed deployment: local/staging validation only.
- **P01 — in progress (foundation only); 3–5 estimated weeks.** Exit: tenant-isolated platform and employee workflows, server-side capability/capacity controls, basic recovery evidence. Allowed deployment: internal staging; no public release.
- **P02 — draft inventory API/UI and synthetic contracts/preflight started; 4–6 estimated weeks.** Exit: reconciled attendance and leave with tested real K50 recovery. Allowed deployment: expressly agreed attendance-only pilot after applicable security/privacy gates; payroll remains unavailable.
- **P03 — not started; 4–6 estimated weeks.** Exit: independently reconciled payroll engine and approved rule packages. Allowed deployment: supervised shadow payroll; existing payroll remains authoritative.
- **P04 — not started; 3–5 estimated engineering weeks.** Exit: two consecutive live payroll cycles reconciled, collection/grace behavior tested, operational/security sign-off. Allowed deployment: controlled commercial production.
- **P05 — not started; 4–6 additional estimated weeks.** Exit: expense and asset gates, phased rollout and rollback evidence. Allowed deployment: opt-in production modules.

Updated delivery boundaries: P01 employee compensation entry/history is locally implemented without calculation; P02 implements the local connector; P03 adds automatic monthly generation and draft/final report downloads. P04 subscriptions are Kinto service fees, not employee salary transfers. P02 contracts/preflight are preparatory only; remaining P02–P04 additions remain planned.

Leave/payroll clarification: P02 includes per-type annual entitlements and hard monthly usage caps, with reservations and atomic over-limit rejection. P02 settles reviewed uncovered absence using the company choice of salary deduction or available paid Annual leave first; P03 deducts only residual unpaid absence and separately approved unpaid leave from the closed period, showing leave/absence units, salary, itemized deductions and net payable in reports. Pending leave and uncertain attendance remain blockers; no guessed absence deductions. Company-wide settings include leave limits, absence fallback and check-in/out plus full/half-day target/minimum hours. See C08–C10/D09–D10 in the decision register. No implementation status changes are implied.

Phases 0–4 retain the blueprint's 16–25 week sequential estimate. Assumptions: two experienced engineers, part-time design/QA, available hardware and a Pakistan payroll specialist. These are not commitments or measurements of coding-agent speed. External procurement, business approvals and live monthly cycles may extend elapsed time. Re-estimate after Phase 0; do not invent a calendar deadline from these ranges.

## How implementation should run

Each numbered work package in a phase is a small, reviewable delivery slice with matching acceptance checks. Implement in listed order unless dependencies expressly permit overlap. A slice is complete only after schema, backend behavior, UI where applicable, tests and operating notes are delivered together.

For each slice, the implementing agent must:

1. Read this index, the shared spec, decisions and the selected phase. Inspect the actual repository; do not assume planned code or commands exist.
2. Record the selected package and relevant blocked decisions. Do not change product scope or a sensitive policy silently.
3. Add the smallest required migration, behavior and interface. Preserve previous phase behavior; avoid unrelated refactors.
4. Run relevant existing checks and new acceptance tests, including negative authorization paths. Record actual commands, results, unresolved failures and evidence paths in the phase's implementation record.
5. Update documentation/status only to the level achieved: implemented, locally verified, staging verified, pilot verified or production approved. These are distinct states.
6. Stop at required human/external gates. Do not enable payments, deploy publicly, touch production biometric logs or process real payroll merely to make a test pass.

Every phase document ends with an implementation record. Complete evidence there as work happens. Do not prepopulate approvals or mark these document checklists as test results. The product owner subsequently authorized implementation and commits to `usama124/kinto-hr`; paid services, live data and public deployment remain unapproved.

## Ownership and approval

P01-03 is locally complete across two bounded increments. [Base-entitlement evidence](../evidence/phase-01/base-entitlements.md) covers immutable price-free plan versions, base subscriptions and subscribed capacity. [Entitlement-control evidence](../evidence/phase-01/entitlement-controls.md) covers operator-authorized dated complimentary/capacity grants, the employee-limit override, preview/revocation, overlap rejection and version changes. Complimentary mode suppresses collection without changing role permission. Only the implemented company-setup capability is present; pricing, invoicing and collection remain Phase 4 work.

P01-04 is locally implemented through [basic onboarding/offboarding checklists](../evidence/phase-01/employee-checklists.md) and [explicit post-rehire account reactivation](../evidence/phase-01/employee-account-reactivation.md), including an automatic final-settlement review task when termination is scheduled. P01-05 now includes a [digest-backed employee CSV validation and atomic confirmation workflow](../evidence/phase-01/employee-import-preview.md) and an off-by-default [local-test document upload/scan/HR-and-employee-download and logical-replacement boundary](../evidence/phase-01/employee-documents.md), a responsive [owner/HR document manager](../evidence/phase-01/employee-document-workspace.md), an [employee shared-document workspace](../evidence/phase-01/employee-shared-document-workspace.md), plus a [profile-change employee/HR workspace](../evidence/phase-01/employee-profile-change-requests.md), a tenant-safe [workforce headcount report snapshot](../evidence/phase-01/workforce-headcount-report.md), [audited asynchronous CSV exports](../evidence/phase-01/workforce-report-exports.md) and a [responsive report workspace](../evidence/phase-01/workforce-report-workspace.md). Production object storage/scanner operations/download, approved retention purge and file recovery remain.

Account provisioning clarification: [C11–C12](DECISIONS.md) exclude company and employee self-signup in all phases and plans. Platform admins create companies/initial owners; company admins/authorized HR create employee accounts within their tenant. Company/employee request and exact-identity activation boundaries are locally implemented. The local provider invitation/recovery paths are verified but not approved for production. Recovery must not create or restore revoked access. The Phase 1 acceptance checklist includes these authorization and recovery tests.

The product owner decides commercial scope, defaults and customer commitments. The engineering implementer supplies code and technical evidence. A reviewer verifies security and critical invariants. A qualified Pakistan payroll specialist approves applicable rules and expected results. The customer payroll approver signs off pilot reconciliations. The operator accepts recovery, incident and support responsibilities. One person may cover several roles only where that does not defeat required independent payroll review or separation of duties.

## Universal phase acceptance

All required work packages pass; no unexplained payroll discrepancy, cross-tenant exposure, data-loss defect or broken authorization remains. New migrations apply to a clean database and the previous release. Relevant replay/retry, permission, restore and browser journeys pass. No production secrets or personal customer data enter fixtures. Feature entitlement does not substitute for role permission. Applicable external decisions are resolved or the affected capability stays disabled and is explicitly excluded from release.

The first delivery is the safe **P00-04 / P01-01 foundation slice**, with evidence in [the foundation record](../evidence/phase-01/foundation.md). Subsequent P01-01 slices add the local worker/runtime, migration regression coverage, synthetic database restore drill and private worker monitoring; see [worker evidence](../evidence/phase-01/worker.md), [recovery/monitoring evidence](../evidence/phase-01/recovery-monitoring.md) and [operating procedures](../operations/foundation.md). P01-02 identity, tenant administration, audit access and organization-policy application boundaries are locally verified. A responsive [owner membership workspace](../evidence/phase-01/membership-access-workspace.md) now exposes existing administrative role changes and revocation; the [administrator invitation workspace](../evidence/phase-01/administrator-invitation-workspace.md) now supports owner-created setup and exact-request retries. The [platform company onboarding workspace](../evidence/phase-01/platform-company-workspace.md) now supports operator-only creation and exact retries. The [platform company directory](../evidence/phase-01/platform-company-directory.md) now provides operator-only company and base commercial metadata listing. The [operator entitlement workspace](../evidence/phase-01/platform-entitlement-workspace.md) supports effective state/history, preview, creation and versioned revocation. Persistent [creation idempotency/reconciliation](../evidence/phase-01/entitlement-creation-idempotency.md) is locally verified. Persistent [revocation retry reconciliation](../evidence/phase-01/entitlement-revocation-idempotency.md) is locally verified. The [foundation acceptance-gap review](../evidence/phase-01/foundation-acceptance-gaps.md) identified and closed the [employee account provisioning workspace](../evidence/phase-01/employee-account-workspace.md) gap. The [explicit schema isolation/test classification gate](../evidence/phase-01/schema-isolation-classification.md) is locally implemented across CI, migration upgrades and database recovery. The [opt-in provider identity-status guard](../evidence/phase-01/provider-identity-status.md) adds fresh login/session checks and session revocation on confirmed disable without changing company memberships. The [opt-in durable provider logout inbox](../evidence/phase-01/durable-provider-logout.md) now records verified callbacks, enforces persistent session revocation and retries cleanup across API restart. The [private logout health command](../evidence/phase-01/provider-logout-monitoring.md) now checks read-only backlog aggregates and emits bounded, redacted alert diagnostics. Deployed scheduling/alert delivery and operational approval remain. P01-03 and P01-04 are locally implemented. P01-05 employee import validation/confirmation, document metadata quarantine, a local-test upload/scan/HR-and-employee-download and logical-replacement path, the responsive owner/HR document manager and employee shared-document workspace, the profile-change employee/HR workspace, workforce headcount report API, audited asynchronous CSV exports and the responsive report workspace are implemented; production object transfer/scanning/download, approved retention purge and file recovery remain. Provider callback reconciliation, identity-disable synchronization, deployed backup/PITR/file recovery, notification routing, approved staging and remote CI evidence remain operational gates. P00-01 still needs owner-approved pilot details; K50 hardware and payroll review gates remain external dependencies.

### Optional restricted bank details — 3 October 2026

The [bank-details increment](../evidence/phase-01/employee-bank-details.md) implements optional account capture, optimistic versioning and explicit clearing behind separate recent-MFA payroll permissions. Preparers read/write; approvers read only. Owner/HR alone never gain financial access. Ordinary roster/contact/audit/outbox projections remain free of bank values. Payments, account verification and payroll remain outside this increment. Next local step is foundation release-readiness evidence consolidation; production deployment, security/privacy approval, storage/scanning, alert delivery and file/PITR recovery remain open.

### Foundation release-readiness review inventory — 3 October 2026

The [review inventory](foundation-readiness.json) and [readiness diagnostic](../evidence/phase-01/foundation-release-readiness.md) now separate historical local evidence from nine foundation review areas and four later-phase dependencies. `pnpm foundation:readiness:verify` checks integrity within CI; `pnpm foundation:readiness` reports revision/dirty state and exits review-required without running tests or approving deployment. No production acceptance or phase-completion claim is inferred. Next: review any remaining local contract gaps and prepare the approved staging/release exercise; safe synthetic Phase 2 work remains possible while hardware/payroll evidence is gated.

### Synthetic attendance preparation — 4 October 2026

[Strict ingestion contracts and pure preflight](../evidence/phase-02/attendance-ingestion-contracts.md) begin safe P02 preparation. No device registry, machine authentication, ingestion route, durable receipt or attendance effect exists yet. Next local slice is tenant-scoped device registry/provisioning authority; real K50 compatibility and production acceptance remain gated.

### Draft device inventory API — 4 October 2026

[Tenant-scoped inventory](../evidence/phase-02/attendance-device-inventory.md) adds owner-only registration/versioned editing/retirement and owner/HR reads with recent MFA, audit/outbox writes, restricted PostgreSQL access and synthetic restore coverage. Draft records are never active or authenticated devices; adapter/source identity remain unverified. Next: the inventory workspace, then versioned device/connector entitlements and machine enrollment. Hardware, attendance processing, leave and production approvals remain pending.

### Device inventory workspace — 4 October 2026

[The device screen](../evidence/phase-02/attendance-device-workspace.md) now exposes draft registration, versioned metadata editing and confirmed retirement for owners, plus read-only HR inventory and bounded next/first-page navigation. Uncertain/stale writes lock editing until a refreshed session/inventory is loaded; denied access discards company data and form state. Every device remains unconnected and unverified. Next: versioned device/connector feature and capacity entitlements before machine enrollment. The remaining P02-01 registry activation, credential rotation, mappings and hardware acceptance are still pending.

### Explicit attendance allocation controls — 4 October 2026

[Immutable operator allocations](../evidence/phase-02/attendance-entitlement-controls.md) add separate attendance device/connector limits with fresh authority, optimistic versioning, exact-request replay and transactional audit/outbox. All plans default disabled/zero; existing employee entitlements and complimentary billing remain unchanged. Allocating capacity does not activate devices or grant machine access. Next: allocation management/review workspace, then single-use enrollment with atomic usage enforcement. P02-01 remains partial; hardware and production gates remain pending.

### Attendance allocation workspace — 4 October 2026

[Operator management and company read-only review](../evidence/phase-02/attendance-allocation-workspace.md) now expose explicit versioned attendance capacity. Review/confirmation and exact uncertain-request retry preserve the original payload/key; fresh session/CSRF and strict tenant snapshots protect refresh/retry boundaries. The web platform API forwarding gap is repaired without changing backend authority. Machine access remains unavailable. Next: single-use connector enrollment and atomic capacity reservations/binding before credential activation. P02-01 and production/hardware acceptance remain partial.

### Connector enrollment reservations — 4 October 2026

[Owner-issued enrollment tokens and reservations](../evidence/phase-02/connector-enrollment-reservations.md) now provide 15-minute digest-only issuance, non-secret exact retry, metadata history and terminal revocation. Shared-lock capacity prevents oversubscription or allocation reductions beneath live reservations; expiry/revocation release slots. Token redemption and machine credentials remain unavailable. Next: single-use redemption, conversion to actual usage and revocable credentials with fail-closed restore semantics, then owner/local connector workflows. P02-01 and hardware/production acceptance remain partial.

### Internal connector credential boundary — 4 October 2026

[Internal single-use redemption and revocable credentials](../evidence/phase-02/connector-machine-credentials.md) convert reservations to bounded usage, bind company/device/enrollment generations, preserve digest-only secrets and require independent positive Redis admission state. Synthetic restore tests deny externally revoked credentials even when PostgreSQL restores an old active row. The local authority is not mounted or production configurable; heartbeat-only scope does not implement a heartbeat endpoint. Public machine access remains unavailable. Next: review/implement the production admission-store lifecycle and mount protected machine/owner credential endpoints, then enrollment workspace and local connector service. Rotation, K50 evidence, ingestion and attendance/leave/payroll remain pending; P02-01 is partial.

### Protected local connector HTTP — 4 October 2026

[Opt-in local HTTP workflows](../evidence/phase-02/connector-local-http.md) expose generation-bound owner enrollment, metadata/revocation and bearer-only heartbeat probes. Disabled by default; production/remote/non-synthetic configuration is rejected. Browser sessions and forwarding assertions cannot authenticate machine routes; company commands retain selected tenant/CSRF/recent-MFA and SQL permissions. Enabled-mode readiness includes the separate admission store. Next local slice: the owner enrollment/credential workspace with one-time secret and uncertain-response reconciliation, followed by the local connector service. Production admission-state lifecycle/review, rotation, K50 evidence, durable ingestion and later phases remain pending. P02-01 remains partial.

### Connector enrollment workspace — 4 October 2026

[The owner/HR connector screen](../evidence/phase-02/connector-enrollment-workspace.md) adds one-time token display, strict versioned issuance, metadata pagination and confirmed revocation. Uncertain commands retain their exact in-memory request across refresh, block new writes and obtain fresh session/CSRF on retry. Tokens disappear on hiding/refresh/expiry; credentials are never revealed or recovered in the browser. HR is read-only, and disabled local mode or lost access clears company display. Next: local connector client/service lifecycle preparation without choosing the hardware adapter runtime prematurely. OS-protected storage, actual K50/SDK evidence, production admission lifecycle/review, rotation and durable ingestion remain pending. P02-01 remains partial.

## Local connector client preparation — 4 October 2026

The [synthetic lifecycle client](../evidence/phase-02/local-connector-client.md) adds one-shot bound enrollment, private memory credentials, explicit heartbeat and abortable shutdown against the gated local-test API. Unknown enrollment outcomes require owner reconciliation rather than retry. This reference tool does not select the hardware runtime or complete P02-01/P02-02. Next: device employee mapping preparation, with production admission, OS-protected storage, rotation, SDK/device evidence and durable ingestion still pending.

## Device employee mapping API — 5 October 2026

[Preparatory mapping API and persistence](../evidence/phase-02/device-employee-mappings.md) add owner-only keyed create/end commands, owner/HR bounded history and full-history event-time resolution. Exact string IDs and half-open intervals preserve leading zeros and ID reuse; database exclusion/FK constraints, fresh authority, atomic audit/outbox and private receipts protect conflicts/retries. Synthetic recovery includes mappings and receipts. P02-01 remains partial. Next: mapping workspace; hardware, production admission, rotation, durable ingestion and locked-period reprocessing safeguards remain pending.

## Device mapping workspace — 7 October 2026

The [owner/HR mapping screen](../evidence/phase-02/device-mapping-workspace.md) adds selected-device history, independent keyset pagination, exact string/date assignment, confirmed versioned ending and full-history event-time lookup. Unknown commands retain the original actor/company/device/key/payload across in-page refresh and use fresh CSRF on explicit retry; malformed/denied reads erase data/forms and new writes remain blocked until reconciliation. Retired history stays readable/endable, HR stays read-only, and no attendance effect is claimed. P02-01 remains partial. Next: synthetic durable raw ingestion preparation; hardware/source identity, production admission, rotation, reprocessing and locked-period gates remain pending.

## Synthetic durable attendance inbox — 7 October 2026

The [internal synthetic inbox](../evidence/phase-02/synthetic-attendance-inbox.md) persists sanitized quarantined records, transport/source fixture deduplication and exact ordered receipts with atomic audit/outbox. Concurrent retries, re-polls, connector replacement, conflicts, permission loss, rollback and SQL restore are tested. No HTTP upload route or machine permission is added; P02-01/P02-02 remain partial. Next: synthetic connector durable capture/queue and receipt reconciliation, while hardware/source identity, secure host storage, production admission/rotation, mapping reprocessing and locked-period gates remain pending.

## Synthetic durable connector queue — 8 October 2026

The [private local queue](../evidence/phase-02/synthetic-connector-queue.md) commits sanitized captures before returning, freezes stable bounded batches, resumes after process termination and reconciles receipts atomically. Lost ACKs preserve the exact server request; rejected records remain held for explicit unchanged retry. Private SQLite files, immutable company/device/connector/adapter binding, retained transport identity history and bounded capacity fail closed without discarding punches. This POSIX/Node fixture stores no credentials and enables no network upload or K50 SDK. P02-01/P02-02 remain partial. Next: synthetic delivery/retry coordination over a trusted test transport; hardware/source proof, secure credential storage, production admission/rotation, mapping reprocessing and finalized-period safety remain open.

## Synthetic delivery/retry coordination — 9 October 2026

The [bounded fixture coordinator](../evidence/phase-02/synthetic-delivery-coordinator.md) dispatches one persisted batch over a trusted callback, retries only explicit transient failures, pauses uncertain/time-out/invalid replies and blocks overlapping unsettled attempts on the same instance. Stop cancels delivery/backoff without losing records; denial is terminal; receipt commit failure preserves exact retry input. PostgreSQL/SQLite integration proves lost-ACK reconciliation and retained rejections. No HTTP uploader, SDK, credentials or machine permission is added. P02-01/P02-02 remain partial. Next: synthetic inbox exception review and mapping-resolution preparation, while production admission, secure host storage/rotation, hardware/source/clock proof and finalized-period safety remain open.

## Synthetic inbox review and mapping previews — 10 October 2026

The [internal owner/HR review proof](../evidence/phase-02/synthetic-inbox-review.md) adds bounded quarantine history and full-history mapping previews from persisted source IDs. Explicit preview times stay operator-supplied/unverified; matching a mapping never clears quarantine or affects attendance/payroll. Fresh owner/HR/MFA, tenant/device/event isolation, retired history, private function grants and restored preview boundaries are tested. No public API or live uploads are enabled. P02-01/P02-02 remain partial. Next: opt-in synthetic owner/HR review HTTP boundary and then its workspace, with hardware/source/clock, host credentials, production admission/rotation and finalized-period gates still open.

## Gated synthetic inbox review HTTP — 10 October 2026

The [local-test review HTTP boundary](../evidence/phase-02/synthetic-inbox-http-review.md) exposes read-only quarantine pages and explicit-time mapping previews through existing selected-company sessions, address limits and server-derived recent MFA. Strict queries reject source/identity overrides; SQL still checks active owner/HR authority. Default-disabled and production gates remain unchanged. Enabled readiness and shutdown include the inbox database. No upload, reprocessing or attendance effect is enabled. Next: the owner/HR synthetic review workspace. Hardware/source/clock proof, host credentials, production admission/rotation and finalized-period safety remain open; P02-01/P02-02 are partial.

## Synthetic inbox review workspace — 10 October 2026

The [owner/HR synthetic review screen](../evidence/phase-02/synthetic-inbox-workspace.md) now exposes bounded quarantine pages and explicit unverified mapping previews. Independent device/event pagination, strict scope/cursor/snapshot checks and fresh session checks before publication prevent stale or mismatched display. Refresh/edits/access loss erase records/forms/results; retired history remains readable. No upload, promotion, processing or payroll effect is enabled. P02-01/P02-02 remain partial. Next: P02-03 company-wide timing policy preparation, retaining hardware/source/clock, protected host credentials, production admission/rotation and finalized-period gates.
