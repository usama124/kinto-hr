# Shared production system specification

Version 1.0 · 28 August 2026 · Applies to phases 0–5 · Required baseline, not verified implementation

See the [roadmap](README.md) for scope and the [decision register](DECISIONS.md) for unresolved approvals. Normative words such as MUST and required describe intended acceptance behavior.

## 1. Architecture and repository

Use a TypeScript modular monolith: Next.js/React web interface, NestJS API, PostgreSQL, Prisma plus reviewed SQL migrations, BullMQ/Redis workers, and private S3-compatible document storage. Keep domain rules in backend modules shared with workers, never duplicated in UI calculations. Durable database records, not Redis jobs, are the source of truth.

Planned directories: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/domain`, `packages/database`, `packages/test-fixtures`, `connectors/k50`, `infra`, and `docs`. These directories are not represented as existing application code. Use a pnpm workspace; pin supported runtime/library versions and container digests after P00-04 compatibility checks. Do not use floating `latest` in production.

Local development needs PostgreSQL, Redis, an OIDC identity provider, private object-storage substitute and email capture. Keycloak is the default local OIDC provider; record whether production uses it or a managed compatible provider before production credentials exist. Choose the K50 connector runtime only after the real SDK test; the web stack does not constrain it. SQLite is permitted for the connector's durable local queue, not as a replacement for PostgreSQL integration tests.

Deploy a same-origin website with `/api/v1` routed to NestJS. Run the worker separately. Use separate development, staging and production identities, data, storage, secrets and network controls. The exact hosting vendor/region is a Phase 0 decision. No infrastructure purchase or public deployment is implied by these specifications.

## 2. Identity, sessions and permissions

Use OIDC authorization-code flow with PKCE, state/nonce validation and a maintained protocol library. NestJS owns the callback and a server-side session; the browser gets a Secure, HttpOnly, SameSite cookie and no long-lived token in localStorage. State-changing cookie-authenticated requests require CSRF protection and origin checks. Restrict redirect URLs, token issuer/audience and allowed algorithms; verify signatures and expiry. Keycloak documents the OIDC endpoints and flow; provider-specific MFA claims must be tested rather than assumed. [OIDC reference](https://www.keycloak.org/securing-apps/oidc-layers)

Working session defaults: 30-minute idle expiry, 12-hour absolute expiry, and reauthentication within 5 minutes for privileged grants, payroll finalization and payment approvals. Privileged roles require MFA. Invitations expire after 48 hours, are single-use, store only a digest and bind to a verified intended identity. Passwords and recovery are the identity provider's responsibility. Revoking membership takes effect on the next API authorization check, including existing sessions; workers recheck relevant permissions before side effects.

Users are global identities keyed by verified issuer/subject. Memberships bind users to tenants; an employee may have no login. An employee-user link is tenant-scoped. Do not automatically grant membership because an email domain matches. Rate-limit authentication and invitation flows without exposing whether an unrelated identity exists.

Permission keys use `resource.action` plus `self`, `team`, `branch` or `tenant` scope. Initial roles:

- Company owner: organization and membership administration, billing and employee administration; **no automatic payroll-detail or finalize permission**. Payroll roles must be explicitly assigned and audited.
- HR administrator: employee/documents/leave/attendance administration; no bank details or salary calculation access by default.
- Payroll preparer: salary inputs, calculation, payroll reports; cannot approve/finalize their own run.
- Payroll approver: review/finalize eligible runs; cannot silently alter their inputs.
- Manager: assigned team's requests and attendance; no salary/bank details.
- Employee: own permitted profile, requests, attendance and published payslips.
- Auditor: read-only access to explicitly granted modules and fields; not all HR data by default.
- Platform operator: tenant commercial status and technical health; no normal customer employee/payroll access.

Phase 1 uses predefined roles; arbitrary custom roles are later scope. Phase 3 adds restricted rule-maintainer and independent rule-reviewer templates for its separately granted publication workflow. Team scope is derived from authorized reporting relationships, not a list submitted by the browser. Keep a last-active-owner guard. Support access requires a customer-approved, time-limited grant with actor identity and audit trail; shared passwords and silent impersonation are forbidden.

## 3. Tenant boundary and database conventions

Tenant-owned rows include UUID `id`, `tenant_id`, created/updated timestamps, actor metadata where applicable, and an integer `version` for mutable aggregates. Use tenant-aware unique constraints and composite foreign keys `(tenant_id, referenced_id)`. Global identity and control-plane records are explicitly classified; their narrow lookup services do not expose arbitrary tenant data.

Resolve tenant context from an authenticated membership or provisioned connector credential. A path/header tenant identifier is only a selector that must be authorized. Row-level security complements scoped application queries. Use a non-owner runtime role without superuser/BYPASSRLS; migration credentials are separate. Missing context denies access. PostgreSQL documents privileged-role/owner bypass and row policy behavior. [Row-security reference](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

Set context transaction-locally on the same connection as all tenant queries; never use session-persistent context across pooled requests. Prove this with the chosen ORM. Execute concurrent alternating-tenant queries, rollbacks, errors, nested service calls and worker jobs under realistic pooling. Global scheduler enumeration is a narrowly privileged control-plane operation returning tenant/work IDs; each work item then enters an ordinary tenant-scoped transaction. Never solve scheduling by giving the normal worker unrestricted payroll access.

Store event instants as UTC `timestamptz`; retain source-local device timestamp, source timezone and interpretation status. Workday/leave dates are local `date` values. Effective-dated intervals use `[start,end)` internally, reject overlapping versions and translate user-facing inclusive dates consistently. Employment termination fields explicitly identify the final working date.

Store currency as ISO code, money as `numeric(18,2)`, rates/intermediate values as an appropriate higher-precision numeric (initially `numeric(24,8)`). API decimal values are strings. Use a decimal library in the domain engine and a documented rounding policy at each boundary; no binary floating-point money. PostgreSQL documents exact numeric types; these precision choices are project requirements, not statutory rules. [Numeric reference](https://www.postgresql.org/docs/current/datatype-numeric.html)

Classify data as public configuration, tenant operational, restricted HR/payroll or secret. Separate restricted fields and enforce projections. Do not globally deduplicate employees using CNIC or bank details across customer tenants. Sensitive identifiers may use envelope encryption with managed keys and tenant-scoped keyed lookup digests if lookup is required; no plaintext copies in search/logging. Delete/archive through lifecycle and retention rules, never an unqualified cascade from employee to payroll.

## 4. API contract conventions

Tenant business routes begin `/api/v1/tenants/{tenantId}`. Platform routes begin `/api/v1/platform`; employee routes below `/me` derive the employee from membership. Connector routes are separate machine endpoints. Route examples in phase specs inherit these prefixes unless explicitly absolute.

Define OpenAPI request/response schemas alongside each endpoint before UI integration. Reject unknown sensitive fields, apply length/format bounds, and authorize returned fields. List responses are `{items,nextCursor}` with opaque cursor and maximum page size 100. Decimal strings and ISO timestamps/dates follow section 3. Error body: `{code,message,requestId,fieldErrors?}` with no stack trace or sensitive record content.

Status rules: 401 unauthenticated; 403 known permitted-scope action denied (including `FEATURE_DISABLED`); 404 unknown or cross-tenant resource; 409 stale version, capacity or state conflict; 422 validation; 429 limit exceeded with retry guidance; 503 transient service dependency. Do not leak cross-tenant existence through errors. Creation returns 201; asynchronous accepted operations return 202 plus a tenant-scoped job resource; callbacks never imply completion.

Require an `Idempotency-Key` for imports, connector batches, payroll operations, grants and payment operations. Persist scope, request digest and result; same key/different payload returns 409. Ordinary command keys live at least 7 days; financial/business uniqueness constraints remain durable independently of key expiry. Connector event uniqueness lasts for retained source events. Mutable updates carry `version`; stale updates return 409 rather than last-write-wins.

Every mutation checks role/data scope, tenant security state and action-specific entitlements at the server. Serially enforce state transitions in a transaction. Export/read permissions are not inferred from edit permissions. A UI hidden button is not a security control.

## 5. Jobs, events and consistency

Write domain changes, audit entry and outbox event in one transaction. Dispatch only committed outbox rows to the queue; record durable consumer receipts or business unique keys. Handle at-least-once delivery, worker death and replay with idempotent effects. Job progress comes from a database job row, not a browser guess. NestJS provides BullMQ integration; the project adds these stronger persistence requirements. [Queue reference](https://docs.nestjs.com/techniques/queues)

Event envelope: `eventId`, `schemaVersion`, `tenantId`, `type`, `aggregateId`, `aggregateVersion`, `occurredAt`, `actorRef`, `correlationId`, and minimal `payload`. Do not put salaries, CNICs, bank numbers, fingerprint data or document contents in queues. Workers fetch authorized records. Use bounded retries with jitter, dead-letter visibility, manual replay with a reason, and per-tenant concurrency limits. PostgreSQL locks/constraints protect correctness; Redis locks alone do not finalize payroll or allocate seats.

Events are versioned; deploy consumers supporting new and previous schema before producers switch. Critical job execution checks current tenant state, resource versions and entitlement policy. If data changes while calculating payroll, the run becomes stale and approval is blocked.

## 6. Files, audit, notifications and exports

Uploads enter private quarantine with a tenant-bound random key, size/MIME/content checks and malware scan. Working document limit: 10 MB, PDF/JPEG/PNG only; additional formats need explicit review. Only clean objects can be downloaded. Authorize each download and issue a short-lived URL (maximum 5 minutes); avoid sensitive names in keys. Metadata alone never proves an object is safe. Deletion follows retention/legal-hold policy, including backups.

Audit actors, action, tenant, resource, time, reason, request ID and safe changed-field metadata. Do not duplicate restricted full values into audit logs. Business mutation and audit failure succeed/fail together. Audit writes are append-only to runtime roles. Operator/security logs have separate access controls. Do not describe the resulting log as tamper-proof.

Exports are tenant/role-scoped asynchronous jobs, private, expire by default after 24 hours, and are authorized again on download. Escape spreadsheet formula injection. CSV import defaults: maximum 5,000 rows or 10 MB, no silent partial success, preview/validation before confirmation; exact per-phase commit semantics are specified there.

Notifications use in-app/email with neutral content and authenticated links; no salary amounts or sensitive identifiers in email bodies. Notification delivery failure must not roll back approved business state; retries remain observable.

## 7. Entitlements and availability boundaries

Separate tenant security state, subscription lifecycle, feature flags, entitlement grants and role permissions. The shared resolver returns effective feature/capacity, version, validity and reason. A complimentary account changes collection obligations, not tenant isolation or permission rules. Future modules are disabled until implemented, tested and granted; do not sell an unavailable module because a plan names it.

Capacity is the simultaneous active-employee limit, enforced under a tenant capacity-row lock for activation and import commit. Employees without logins count. Scheduled future activation reserves a seat or is rejected; Phase 1 defaults to explicit activation only. Terminated/archived workers do not consume a current seat; their period participation and historical payroll remain intact. Device ingestion never deletes already received events to enforce capacity.

Use action classes: historical read/export; employee activation/configuration; device ingestion; attendance processing; payroll preparation/finalization; billing recovery. Phase 4 defines permitted classes by commercial state. A security suspension is stronger than commercial grace; normal access is denied and any data recovery uses an approved support process.

## 8. Proposed operating targets and test envelope

These are engineering acceptance targets for launch, not a published SLA or measured capacity. Phase 0 must cost them; Phase 4 must supply actual measurements before claims.

- Benchmark dataset: 100 tenants, 250 active employees per tenant, 90 days at four punches/employee/workday using a synthetic 90-day all-workday stress case (9 million events), plus historical payroll. Test 50 concurrent interactive users and 20 simultaneous connector uploads with a documented host/database configuration.
- Normal paginated API p95 below 750 ms server-side under the benchmark; list-page useful content within 3 seconds on the documented browser/network profile. Imports, reports and payroll are asynchronous and excluded from this interactive bound.
- A 250-employee payroll calculation below 2 minutes and a 5,000-row import below 5 minutes under the same test profile, with reconciled results and recorded queue delays.
- Connector initial polling candidate: 60 seconds with jitter; pending real K50 load validation. Target healthy punch-to-visible delay below 2 minutes. Show data freshness instead of promising real time.
- Proposed service availability target: 99.5% monthly, measured at the application boundary. Disaster targets: cloud database RPO at most 15 minutes and RTO at most 4 hours. Acknowledged events are durable within the database; catastrophic recovery still has an RPO and device replay must not be assumed infallible.
- Proposed local connector buffer: 7 days at the supported event volume, with alerts at 70%/90% capacity. Validate disk budget, power/restart and actual device retention; do not delete unacknowledged events to hide pressure.

Back up PostgreSQL with point-in-time recovery and private object storage with suitable versioning/recovery; retain protected backups for an initial 35-day operating target subject to approved retention policy. Identity and configuration recovery are part of RTO. Configure alerts for failed backups, queue age, connector silence/backlog, repeated authorization failures, payroll exceptions and payment reconciliation errors.

Retention for employee/payroll/source attendance is a separate legal/customer decision before live data. Do not treat a 35-day backup policy as permission to delete payroll after 35 days. No automated customer-record purge until an approved retention schedule exists.

## 9. Migration, deployment and definition of done

Use expand/migrate/contract changes; apply migrations separately with restricted release credentials. Test clean-install and previous-release upgrades with representative data. A release rollback normally rolls back code/flags, not a destructive schema down-migration. New payroll/rule versions must not recalculate historical finalized runs. Back up and rehearse any required data transformation before production.

CI must establish actual scripts for formatting/lint, typecheck, domain unit tests, real PostgreSQL integration tests, contract tests, browser journeys, build and migration validation. Run dependency/secret scans and review material findings. Synthetic test fixtures must include two tenants, multiple roles, duplicate IDs, boundary dates, capacity races, overnight shifts, invalid files and worker retries. Critical payroll expectations come from independent reviewed fixtures, not snapshots generated by the same implementation.

Each phase adds a deployment/runbook entry, feature rollout/disable instructions, dashboards/alerts and evidence of its applicable targets. Critical/high unresolved security findings and any unexplained monetary discrepancy block release. Accessibility acceptance covers keyboard navigation, labels/focus, useful errors, and responsive forms at 360px and desktop widths; pursue WCAG 2.2 AA as a design target, not a claimed certification.

Keep evidence free of customer secrets. An agent may report code or checks completed only after executing and inspecting them. Production approval belongs to the named responsible humans and cannot be generated from a passing unit test.
