# Phase 2 — K50 attendance, shifts and leave

Version 1.0 · 28 August 2026 · Status: not started · Estimate: 4–6 weeks

Dependencies: [Phase 1](PHASE-01-PLATFORM-PEOPLE.md), P00 K50 evidence and [shared spec](SYSTEM-SPEC.md). Next: [Phase 3](PHASE-03-PAKISTAN-PAYROLL.md).

## Objective, scope and entry

Provide an auditable path from K50 punches and approved leave to locked payroll inputs. Employees request leave/corrections; managers approve; HR resolves exceptions and locks a period. Real device access/SDK licensing gates E01/E08 must pass before hardware release. Simulated ingestion may be built first, but must remain labeled synthetic and cannot pass the device gate.

Include fixed and overnight shifts, full/half-day leave, holidays, weekly rest, approved overtime, manual corrections and CSV fallback after its actual format is verified. Exclude arbitrary shift optimization, split shifts, geofencing, facial matching, biometric template distribution, automatic late-pay penalties and direct cloud push unless separately verified. One assigned shift per employee/workday is the initial model.

## P02-01 — device registry, mappings and connector provisioning

Create tenant/branch device records with model/firmware, source timezone, supported adapter version, connection profile, last sync, health and status. Device connection secrets remain in the local service's OS-protected credential storage, never in ordinary UI/logs. Bind a connector to authorized devices in one tenant; a submitted device serial is not an authentication credential.

A tenant admin creates a single-use enrollment token valid for 15 minutes. The connector redeems it over HTTPS to obtain a scoped revocable machine credential, stored securely on its host; the server stores a verification digest. It may ingest only its assigned tenant/device events and report health, never read payroll or employees outside the mapping minimum. Rotate credentials with an explicitly bounded overlap and revoke them immediately on decommission. Enrollment tokens cannot be reused.

Map source device user ID to employee with effective `[start,end)` validity, tenant and device. IDs are strings to preserve leading zeros. Reject overlapping mappings; an unrecognized or ambiguous ID enters an exception queue, never a guessed employee. Mapping changes can reprocess unresolved events with an audit reason and must not rewrite finalized payroll inputs.

Acceptance: cross-device/tenant spoofing fails; enrollment replay and revoked credentials fail; the same device user ID may map differently on two devices; reused IDs map by event time, with ambiguity flagged. Device and connector limits use the entitlement resolver. Removing a device preserves its historic events.

## P02-02 — local connector and durable ingestion

Implement the SDK/host selected in P00 as a background service with startup/restart support, bounded polling, health logs without PII, durable local queue and controlled installer/update path. The adapter interface provides identity/capabilities, read-event batches and health; deleting logs, resetting the clock, uploading users/templates and unlocking doors are outside its production interface.

Persist each source event locally before attempting upload. Assign a stable connector event UUID and keep it on retries. A proposed 60-second polling interval with jitter is accepted only after testing the K50 and coexistence with existing software. Allow one active reader/lease per device to avoid conflicting polling. Persist a vendor cursor only after the corresponding events are safely captured locally.

Cloud ingestion validates the machine identity, allowed device, schema and payload bounds. Initial maximum: 500 events or 1 MB per batch. Persist accepted raw records, deduplication state and outbox dispatch atomically before acknowledging. Return per-event states: `stored`, `duplicate`, `quarantined` (durably stored) or `rejected_unstored` with code. The connector removes an event from its retry queue only for the first three states; rejected records remain in local exception storage for review, with privacy-safe diagnostics. Timeouts/retries must not lose data.

Use two identities: the transport event UUID for retry safety, and a source-event identity proved by the adapter for re-poll safety. Prefer a vendor event identifier with verified reset behavior. If none exists, document and test a composite/occurrence strategy using actual device behavior. Do not collapse by timestamp alone; retain ambiguous identical source rows for review rather than claiming perfect deduplication. A recreated connector queue must not cause silent duplicate attendance from re-read device history.

Do not ingest fingerprint templates or photos. Allowlist attendance fields before logging/storage; reject unexpected sensitive payloads. Raw source records are immutable, with separate validation/mapping metadata. An encrypted sanitized raw representation can be retained under the approved attendance policy for troubleshooting.

Acceptance: interrupted upload after database commit returns duplicate acknowledgments on retry; service/host restart preserves backlog; malformed records do not block unrelated valid events; replay does not double-count a known event. Test seven-day synthetic backlog/disk pressure and real hardware outage/recovery separately. Report actual device buffer limitations; never silently delete unacknowledged events. Production installer/update packages must be integrity-verified and rollback-tested, with valid SDK distribution permission.

## P02-03 — shifts, event normalization and attendance calculation

Configure versioned shifts: local start/end, overnight marker, fixed unpaid break minutes or explicit break-punch mode, grace minutes, weekly rest days, punch-association window and expected work minutes. Initial break mode is fixed-duration deduction; explicit break-punch mode stays disabled unless pilot scope includes and tests it. If shift end is on the following date, anchor workday to shift start. Reject overlapping assignment/association windows; do not assign one punch to two shifts.

Normalize using source timestamp/timezone, retaining UTC and original time. Mark suspect clock drift or impossible dates; do not silently rewrite the original clock. Capture server receipt time separately. Out-of-order delivery triggers recalculation only for unlocked affected workdays. Changes to shift/mapping/policy create a new calculation version, not raw-event edits.

For the initial fixed-shift policy, use verified punch directions where present; otherwise use the approved first/last valid punch rule within the association window. A single punch or ambiguous event creates `needs_review`, not a full paid day. Calculate worked minutes, break minutes, scheduled minutes, late/early minutes and candidate overtime. Grace affects the configured attendance flag; it does not automatically invent payable time or a salary deduction. Overtime becomes payable only after separate authorized approval.

Day outcomes: `present`, `absent`, `leave`, `rest_day`, `holiday`, `not_employed` or `needs_review`, with separate flags such as late/early/missing punch. Half-day paid/unpaid leave is represented in payable segments, not a misleading single full-day status. Resolve calendar/leave/employment before absence; approved leave must not also generate an absence deduction. Unknown/unassigned schedules are exceptions, not zero hours.

Acceptance: a synthetic 22:00–06:00 shift with 30 unpaid break minutes produces 450 worked minutes for valid boundary punches, attributed to the start date; a missing checkout stays unresolved; duplicate delivery leaves totals unchanged; a holiday is not absence; a later policy version does not change a locked period. Synthetic policy examples are product tests, not labor-law statements.

## P02-04 — leave policies, ledger and approvals

Version leave policies by eligibility, paid/unpaid status, unit, accrual frequency, cap, expiry, carry-forward and probation rules. Default leave quantities use decimal days with supported increments 0.5 and 1.0. Do not invent statutory entitlements: employers configure reviewed policies from P00. Opening balances require source, as-of date, reviewer and an immutable ledger entry.

Ledger entries include opening, accrual, reservation, reservation release, consumption, adjustment, expiry and carry-forward. Submission reserves available balance transactionally; approval converts reservation to consumption once; rejection or pre-approval cancellation releases it. Prevent overlap with another pending/approved leave request. Use effective work calendar to exclude rest/holiday days unless the approved policy explicitly includes them. No negative balances initially; unpaid leave has approval tracking without pretending to consume a paid balance.

State: `draft → pending → approved/rejected/cancelled`. Cancellation of an approved request is a separately approved reversal, not a delete. A cancellation affecting locked attendance creates an adjustment request and cannot immediately alter historical payroll inputs. Self-approval is forbidden; manager approval routes from effective reporting relationships, with an explicit HR fallback when no eligible manager exists. Concurrent approvals/adjustments cannot consume the same balance twice.

Acceptance: two concurrent requests exceeding one available balance cannot both reserve it; repeated approval creates one consumption; cancellation preserves history and reverses once; half-day and holiday overlap calculate expected quantities; unauthorized manager/self-approval fails; scheduled accrual retry creates one ledger entry per employee/policy/period.

## P02-05 — corrections, cutoff and payroll handoff

Employees submit missing-punch or attendance correction requests with date, proposed times and reason. HR/manager decisions append approved adjustments; raw events remain unchanged. Managers approve overtime amounts with reason and do not edit payroll. An employee cannot approve their own correction; each decision is versioned and audited.

Attendance periods are `open → under_review → locked`. Lock requires completed employee/schedule coverage, resolved blocking exceptions, approved payable overtime, reviewed leave and a freshness review for each relevant device. A known delayed/offline device blocks lock unless an authorized HR approver records a documented reconciliation waiver and alternate verified source. Lock stores the source watermark, employee-day version IDs, policy/mapping/calendar versions and approver.

Expose immutable `attendance_input_snapshot` with employee/employment, period, paid/unpaid day/minute segments, approved overtime, exception resolutions and revision hash. This is Phase 3's only attendance source. No payroll calculation reads a moving live dashboard summary.

Reopening requires authorization/reason and is allowed only if no dependent finalized payroll exists; it invalidates draft payroll runs and approvals. If payroll is finalized, corrections create a new adjustment workflow for a later/off-cycle run. Lock and payroll-finalization operations serialize so a concurrent reopen cannot slip past the check.

Acceptance: late-arriving punch after lock is visible as an exception without changing the snapshot; reopening invalidates unfinalized payroll inputs; finalized payroll prevents destructive reopening; unresolved missing-punch records cannot quietly become unpaid salary deductions.

## Data and event contracts

Entities: `devices`, `connectors`, `connector_device_grants`, `enrollment_tokens`, `device_employee_mappings`, `raw_attendance_events`, `event_validation_results`, `device_sync_receipts`, `shift_versions`, `shift_assignments`, `holiday_calendars`, `attendance_day_versions`, `attendance_periods`, `attendance_snapshots`, `correction_requests`, `overtime_approvals`, `leave_policy_versions`, `leave_requests`, `leave_ledger` and `approval_decisions`.

Raw event fields: UUID, tenant/device/connector, source user ID, connector event ID, optional verified source event ID, original local timestamp, timezone, UTC interpretation/status, receive time, optional direction/work code, sanitized source hash and adapter version. Input cannot select an arbitrary tenant. Unique transport key `(tenant_id,connector_id,connector_event_id)`; source uniqueness is adapter-defined/tested. Tenant foreign keys, mapping non-overlap, one consumption/accrual business key and immutable snapshot constraints are required migrations.

Worker events: `attendance.events_stored.v1`, `attendance.recalculate_requested.v1`, `leave.decision_recorded.v1`, `attendance.snapshot_locked.v1`, `attendance.snapshot_superseded.v1`. Dispatch only committed IDs/revisions; workers reload scoped data and recheck lock state before writing. Partitioning is optional after measurement, not a substitute for indexes and bounded queries.

## API, screens and reports

Tenant routes: `/devices`, `/connectors/enrollment-tokens`, `/devices/{id}/employee-mappings`, `/shifts`, `/shift-assignments`, `/holiday-calendars`, `/attendance/days`, `/attendance/exceptions`, `/attendance/corrections`, `/attendance/overtime-approvals`, `/attendance/periods/{id}/lock`, `/attendance/periods/{id}/reopen`, `/leave/policies`, `/leave/requests`, `/leave/requests/{id}/decision`, `/leave/balances`, `/leave/adjustments` and `/me/attendance`/`/me/leave` views. Explicit command routes use version/idempotency and scoped roles.

Absolute machine routes: `/api/v1/connectors/enroll`, `/api/v1/connectors/heartbeat`, `/api/v1/connectors/attendance-batches`; no ordinary employee session can impersonate a connector. Responses include receipt IDs, event disposition and retry guidance without exposing other tenants.

All three machine routes are POST. A batch contains `batchId`, `schemaVersion`, `deviceId`, `adapterVersion` and `events`; each event contains `connectorEventId`, `sourceUserId`, `sourceLocalTimestamp`, optional validated source-event identifier/direction and allowed source metadata. The server derives tenant/connector identity and configured timezone, then returns `receiptId` plus per-event disposition; a device cannot override its assigned timezone/tenant through a batch. `POST /attendance/periods/{id}/lock` supplies expected version, reviewed coverage hash and any authorized reconciliation waiver references. `POST /leave/requests/{id}/decision` supplies request version, decision and reason, never a caller-selected balance change.

Screens: device setup/mapping/health; shifts/calendar; attendance grid and day evidence; exception/correction/overtime queues; leave balance/calendar/request; manager approvals; period review/lock. Show source freshness and pending work, not an unsupported real-time badge. Reports: daily/monthly attendance, missing punches, overtime approval, leave balances and connector backlog.

## Pilot release, verification and rollback

Pass real K50 evidence plus synthetic boundary corpus, two-tenant machine/API isolation, replay/worker-death tests, balance races, local timezone/overnight fixtures, installer verification and source-to-summary reconciliation. Demonstrate the attendance snapshot API with a synthetic consumer. Pilot HR signs off one agreed attendance period, supported model/firmware and documented gaps.

An attendance-only pilot requires approved data terms, functioning permissions/backups and operator support even though Phase 4's wider commercial gate is later. Enable tenants individually. On failure, pause affected adapter/derived processing, preserve raw/backlogged events and use the approved CSV/manual fallback. Never roll back by clearing device logs or deleting accepted events. Revoke a compromised connector and rotate its credentials through a controlled enrollment path.

## Implementation record

- Work packages: P02-01 through P02-05 — not started.
- Hardware/firmware/SDK evidence: pending, not replaced by a simulator.
- Code, tests, reconciliation and rollout evidence: none yet.
- Customer attendance-pilot approval: pending.
