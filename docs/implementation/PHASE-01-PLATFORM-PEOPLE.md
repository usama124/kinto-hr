# Phase 1 — platform, access and employee management

Version 1.1 · 28 August 2026 · Status: foundation slice locally verified; phase incomplete · Estimate: 3–5 weeks

Dependencies: [Phase 0](PHASE-00-VALIDATION.md), [shared spec](SYSTEM-SPEC.md). Next: [Phase 2](PHASE-02-ATTENDANCE-LEAVE.md).

## Objective, entry and exclusions

Deliver a complete internal staging workflow: provision a company, assign capacity, invite users, configure branches, import/manage employees and safely access documents. Foundation-only work may use the roadmap's Phase 0 exception, but real users/data require identity/privacy decisions. No attendance calculation, real payroll or customer invoicing in this phase. Company and employee self-signup are excluded from all phases under C11–C12.

The company owner/HR admin are primary users. Employee self-service is limited to authorized profile viewing/change requests. Platform operators manage tenant capabilities without access to HR content.

## P01-01 — repository, CI and environments

Create the shared-spec workspace and module boundaries, container-based local services, validated configuration, example environment variable names without secrets, migration workflow, seed-only synthetic fixtures and application health/readiness checks. Establish actual scripts for lint, typecheck, tests, integration, browser tests and production build; document exact commands after execution. CI runs against PostgreSQL, not a mocked/SQLite tenant store.

Create a staging deployment description with private database/storage, separate migration credentials, backups, monitoring and secret injection. Provision it only after relevant approval. Health endpoints reveal status, not credentials/configuration. Test missing configuration fails startup safely.

Acceptance: a clean checkout can install locked dependencies, migrate, seed synthetic tenants, run documented checks and build the web/API/worker. A migration failure stops deployment without running partially configured app instances. No unprotected admin/test bypass ships in a production build.

## P01-02 — identity, tenancy, roles and audit

Implement OIDC sessions, membership selection, MFA enforcement, invitations and role/scoped authorization according to the shared spec. Bootstrap the first operator through an explicit protected setup operation, not a public default credential. Use separate control-plane authorization for provisioning tenants; resolve company access through memberships.

Only platform administrators provision company tenants and initial named owners. Company owners/admins and authorized HR provision employee accounts within their own tenant; HR receives a bounded employee-account permission, not general membership/role administration. Send activation/password-setup invitations for this approved access. Disable identity-provider self-registration as well as app/API signup. Provide login and password recovery for existing company users and employees, with recovery unable to create access or reverse revocation. Keep cross-service provisioning pending/denied until the required identity and membership are successfully linked; retries must be idempotent.

Implement transactional audit events, tenant-scoped repositories, RLS and safe database role provisioning. Add legal-entity and branch setup with Pakistan/PKR/Asia-Karachi defaults, configurable province/territory and one legal entity per tenant. A legal-entity identity change is audited; deleting an entity with business records is disallowed.

Introduce the central Company Policies administration boundary with typed domain versions, effective dates, permission checks, preview/publish actions and audit. Initial Phase 1 settings cover implemented organization defaults; Phase 2 supplies timing, leave and absence-settlement validators/screens, and Phase 3 supplies supported payroll-policy settings. Do not expose a working toggle for an unimplemented module or accept arbitrary rules/scripts. Settings apply company-wide with no hidden employee/branch override. Employee-specific salary agreements and explicit company-defined shift assignments remain separate data, not policy bypasses.

Policy acceptance: tenant A cannot read/change tenant B's settings; unauthorized employees/HR cannot publish policy changes; version conflicts fail; one published effective version is selected for each domain/date. Verify the same policy applies to two branches/employees and that a later publication preserves earlier version references. Later phase tests extend this to attendance, quota and finalized payroll history.

Acceptance: tenant A cannot list/read/change tenant B by changing path IDs, files, filters, cursors or job IDs. Missing tenant context denies access. An existing session loses access after membership revocation. HR/manager cannot see bank details or salaries. Last-owner removal fails. Payroll self-approval restrictions are represented in permissions even though payroll is not implemented yet.

Account-access acceptance (required tests, not implemented evidence):

- A platform admin can create a company and initial owner; anonymous users, employees and company admins/HR cannot create company tenants. Public signup is unavailable through the UI, API and identity provider, including Free plans.
- Company admins/authorized HR can provision an Employee account for their own tenant; employees cannot provision accounts, and changing an employee/tenant ID cannot provision access in another company. HR cannot assign owner, platform or payroll roles through this workflow.
- Activation rejects expired, replayed, revoked or wrong-identity invitations. Retries and concurrent requests create no duplicate accounts/links/memberships. Failed identity-provider provisioning grants no active access.
- Existing company users and employees can log in and reset passwords. Unknown-address recovery has the same public response and creates no account. Expired/reused reset tokens fail; password reset cannot restore revoked membership, disabled identity, suspended-tenant access or bypass MFA.

## P01-03 — plan and entitlement foundation

Implement immutable plan versions, per-tenant subscription records, capability/capacity resolution, complimentary grants and a tenant capacity lock. Seed test packages Free 5, Starter 20, Growth 50, Business 100 and Scale 250; prices remain unset and production invoices cannot be issued from these seeds. Only implemented capabilities may be enabled.

Precedence: security suspension denies access; implemented-module flag limits availability; valid base plan plus approved add-on grants determine features/capacity; a dated explicit override replaces only its named field; unspecified fields retain baseline. Reject overlapping active overrides for the same field. Current role/data scope still applies. Record entitlement version and invalidate caches on changes. Decisions affecting allocation use authoritative database state, not cached limits.

A complimentary billing mode suppresses collection while retaining a chosen capacity/package; it is not a universal permission grant. Override/grant edits require operator authorization, reason and audit, and have a preview of effective changes. Grant expiry cannot silently charge a customer without an accepted paid agreement; detailed commercial transitions arrive in Phase 4.

Acceptance: a complimentary 100-seat tenant works without a payment provider; a 20-seat tenant cannot activate employee 21 through UI, API or concurrent import; two competing final-seat activations result in one success. Expiring a grant never deletes employees, files or history. Existing employees can still be offboarded when over cap, while new activations are denied.

## P01-04 — organization and employee lifecycle

Organization records: legal entity, branch, department, designation and reporting manager, all tenant-scoped. Prevent a reporting-line cycle. Changing a manager or branch creates an effective-dated assignment; historical approvals retain actor and scope evidence.

Employee lifecycle: `draft → active → terminated → archived`; a scheduled termination records final working date and is applied idempotently after that date. Draft activation is explicit and reserves capacity transactionally. Rehire creates a new employment period linked to the same employee identity; it never replaces previous payroll/history. No general-purpose hard delete after activation or referenced history.

Required activation fields: unique tenant employee number, display/legal name as needed, joining date, employment type, branch, department/designation and manager or documented top-level exception. Default scope is monthly salaried employees; unsupported worker types cannot be silently treated as salaried. Optional private fields include contact, emergency contact, CNIC and bank details with separate read/write permissions. Validate formats without claiming government verification.

Basic onboarding/offboarding checklists have assignee, due date, completed timestamp and actor. Offboarding revokes linked employee access at the approved effective time, preserves payroll records, and creates a final-settlement task for Phase 3. Asset clearance integration is later Phase 5.

Compensation capture is part of employee onboarding, not postponed to the payroll engine. An authorized company/HR user with explicit compensation read/write permissions can enter PKR monthly basic salary, typed fixed recurring allowances/deductions and an effective date, then add dated increment/revision entries with a reason. Store agreements and component versions separately from the public employee profile; Phase 3 reuses these same records. Reject overlapping effective intervals and retain previous rates. An employee may be saved before compensation is supplied, but show payroll setup as incomplete and never treat missing salary as zero. Ordinary HR/manager membership alone does not grant salary access; an owner may explicitly assign payroll permissions to the designated HR staff. No calculation, statutory validation claim or salary payment is enabled in Phase 1.

Compensation acceptance: authorized HR can add salary in the employee creation flow and later add an increment; unauthorized profile/API/export reads reveal no amounts; future increments preserve past versions; missing salary remains visibly incomplete. Phase 3 must test mid-period proration and finalized-run immutability against this history.

Acceptance: future assignment changes do not overwrite past records; overlapping employment/assignment intervals fail; identical employee numbers in different tenants are valid; duplicate numbers within one tenant return a scoped conflict. Rehire retains prior service/pay records. Archived employees remain available to authorized historical reports and do not consume active capacity.

## P01-05 — imports, documents and self-service

CSV workflow: upload → parse/validate → preview → confirm → commit → results. Initial employee import is create-only; conflicting employee numbers produce row errors, never implicit overwrites. Preview records a file digest and validation revision. Confirmation revalidates permissions, referenced IDs and capacity; any error rejects the whole batch with no partial activation. Stage rows, then commit atomically under the tenant capacity lock. Repeated confirmation returns the same result.

Use a shared file pipeline for employee documents: quarantine, size/type/scan, clean, authorized download, retention-controlled removal. Documents have category, employee, visibility, expiry and optional replacement linkage. Employee-visible and HR-only documents are distinct. CNIC/bank documents do not become visible merely because a person manages the employee.

Employees can request changes to a whitelist of contact/emergency fields. HR approves/rejects with reason; employees cannot edit salary, status, role or manager. Display only actual available profile sections. Add employee roster, joiner/leaver and department counts with scoped CSV exports; audit export creation/download.

Acceptance: bad rows reject import with row-numbered errors and no records changed; confirmation retries create one batch only; spreadsheet formula content is safe in exports. Infected/unscanned files never download. A revoked user cannot retrieve an old document/job URL through the application; short-lived storage URL residual access is bounded to the documented five-minute maximum.

## Data model and migrations

Control-plane entities: `users(issuer,subject)`, `tenants(status,security_status)`, `memberships(user_id,tenant_id,status)`, `roles`, `membership_roles`, `plan_versions`, `subscriptions`, `entitlement_overrides`, `capacity_state` and `support_grants`. Tenant business entities: `legal_entities`, `branches`, `departments`, `designations`, `employees`, `employment_periods`, `employee_assignments`, `employee_private_details`, `employee_user_links`, `documents`, `checklist_tasks`, `profile_change_requests`, `import_batches`, `import_rows`, `jobs`, `audit_events` and `outbox_events`.

Membership unique `(tenant_id,user_id)`; employee number unique `(tenant_id,employee_number)`; employee-user link unique per employment account policy, with no cross-tenant references. Entity/employee child foreign keys include tenant. Effective intervals reject overlap. Capacity count and status changes commit together. Restrict immutable plan versions and audit events at the database permissions level.

Migration order: identity/control plane; tenant context/RLS; organization; lifecycle/private data; files/imports; grants/capacity; outbox/audit indexes. Phase 1 must prove adding a new tenant-owned table cannot pass CI without an isolation policy/test classification.

Add `company_policy_versions` and publication/audit references for the central domain configuration boundary. Use typed module schemas and tenant/domain/effective interval constraints; business modules may store specialized rule records referenced by the common version, without duplicating editable policy sources. Later migrations extend supported policy domains without enabling unfinished behavior.

Add `compensation_agreements`, typed `salary_components` and `compensation_component_versions` alongside employee private data in P01-04. Phase 3 extends these entities rather than creating a second salary source of truth. The employee onboarding form submits compensation through a separately authorized transaction/command; an employee record saved without a successful compensation command must clearly show incomplete payroll setup.

## API and UI contracts

All business paths inherit `/api/v1/tenants/{tenantId}` and shared status/version/idempotency conventions:

- Absolute `GET /api/v1/auth/login`, `GET /api/v1/auth/callback`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/session`; login/callback use OIDC, logout is a CSRF-protected mutation.
- Absolute `/api/v1/platform/tenants` platform-admin-only company/initial-owner provisioning and commercial metadata listing; `/tenants/{id}/grants` preview/create/revoke entitlements, never HR data.
- `/organization`, `/branches`, `/departments`, `/designations`: scoped configuration.
- `/company-policies`, `/company-policies/{domain}/versions`, `/company-policies/{domain}/preview` and `/company-policies/{domain}/publish`: typed, versioned company-wide settings. Publish requires effective date, expected version and reason; the server enforces domain permissions and implemented-module availability. Add a Company Policies screen with supported-domain tabs, effective dates and publication history.
- `/memberships`, `/invitations`, `/memberships/{id}/roles`: owner actions, no self-escalation outside granted administration rights.
- `/employees/{id}/account`: company owner/admin or authorized HR provisions employee access and requests activation delivery within the tenant. HR cannot submit arbitrary roles; general invitations/role administration above remain owner-only. Password recovery uses the identity provider's existing-account flow; no public registration endpoint is provided.
- `/employees` list/create; `/employees/{id}` read/versioned edit; explicit `/activate`, `/terminate`, `/archive`, `/rehire` transition commands.
- `/employees/{id}/compensation` permission-protected read/history and dated creation/revision commands; reject salary fields on the ordinary profile endpoint. Include a salary/history section in onboarding and employee detail for explicitly authorized HR/payroll staff only.
- `/employee-imports` create; `/{id}/preview`, `/{id}/confirm`, `/{id}` result/status.
- `/employees/{id}/documents` register/list; `/documents/{id}/download` authorizes a short-lived link.
- `/me/profile`, `/me/profile-change-requests`, `/profile-change-requests/{id}/decision`.
- `/entitlements` returns effective limits, usage and available features; `/reports/headcount` and `/exports` remain permission-scoped.

Screens: login/password recovery/tenant switch, invitation activation, platform-admin company creation, company setup, members/roles, employee list/detail/history with authorized account provisioning, import preview/results, onboarding/offboarding tasks, document manager, self profile and operator commercial tenant view. No company or employee signup screen. Show meaningful loading/error/permission states and distinguish drafts from active employees. Do not create fake payroll/attendance dashboard totals before those modules exist.

Minimum command contracts: `POST /employees` accepts employee number, name, joining date, monthly-salaried employment type and tenant-scoped organization references; it always creates a draft. `POST /employees/{id}/activate` accepts expected version and atomically consumes a seat immediately; future automatic activation is not implemented in Phase 1, and employment joining date remains a separate historical field. `POST /employee-imports/{id}/confirm` accepts preview revision and file digest; changing either requires a fresh preview. Successful mutations return resource ID, state and new version; no client field can set tenant identity, audit actor or active capacity count.

## Release evidence and rollback

Evidence must cover each work package plus concurrent RLS/seat tests, private-field projections, invitation replay, malicious files/CSV, worker authorization, employee lifecycle and restore of two synthetic tenants. Review keyboard/responsive employee/import flows. Apply migrations to clean and previous schema; restore a database/file sample and demonstrate tenant-specific export without another tenant's data.

Release internally in staging. If identity/isolation fails, disable tenant access and fix it; do not loosen RLS. Roll back via previous compatible app version and flags; preserve imported employee/history records. No destructive schema rollback or customer cleanup without a separate reviewed procedure.

## Implementation record

- Work packages: P01-01 partially implemented; P01-02/03/04 contain internal persistence spikes only; P01-05 not started.
- P01-02 access prerequisite: identity/membership persistence, forced identity/tenant RLS and transaction-scoped permission/MFA checks are implemented internally; see [membership access evidence](../evidence/phase-01/membership-access.md).
- P01-02 authentication increment: optional OIDC code/PKCE/state/nonce/RS256 validation, existing-identity login, Redis server sessions, logout/CSRF and account-access UI are implemented; see [authentication evidence](../evidence/phase-01/authentication.md). A pinned real Keycloak LoA 2/TOTP, reset-email and signed back-channel workflow is locally verified; see [provider evidence](../evidence/phase-01/keycloak-mfa.md) and [revocation evidence](../evidence/phase-01/session-revocation.md). The first protected control-plane increment now separates platform authority, bootstraps only the explicit first operator, and atomically creates an idempotent company plus pending initial-owner request; see [company-provisioning evidence](../evidence/phase-01/company-provisioning.md). Authentication is disabled by default. Generic providers/claims receive no MFA trust. Provider-side owner creation, activation invitations, company/employee provisioning completion, first-owner activation/last-owner safeguards, membership selection/administration and customer security-audit access remain pending.
- Implemented files/migrations and executed checks: see [foundation evidence](../evidence/phase-01/foundation.md). Web/API preview, first migration, restricted runtime role, tenant isolation, atomic draft activation/audit/outbox and regression suites exist.
- Worker/runtime increment: see [worker evidence](../evidence/phase-01/worker.md). Local Redis/BullMQ processing, restricted dispatcher/worker roles, durable receipts/retries, audited local replay, startup/shutdown checks and a staging operating description now exist. Only a receipt-recording foundation consumer is enabled; business automation remains unavailable.
- Recovery/monitoring increment: local synthetic PostgreSQL dump/restore verification, expiring worker-instance heartbeats, private operational health/Prometheus metrics and regression checks are implemented. See [recovery and monitoring evidence](../evidence/phase-01/recovery-monitoring.md). No cloud resources or live-data backups were provisioned.
- Acceptance: no complete work-package or phase acceptance. P01-01 local engineering now includes database recovery and worker monitoring; deployed backup/PITR/file recovery, alert notification delivery and staging review remain. P01-02 initial-owner provider provisioning/invitation activation and company/employee membership administration are next; provider callback failure reconciliation remains a production recovery gate. Immutable entitlements, full employee/compensation lifecycle and imports/private files are also required for Phase 1. The protected platform company-request endpoint is the only business creation endpoint; no employee/payroll endpoint is exposed.
- Migration evidence: four migrations are applied locally; isolated previous-schema upgrade/backfill, explicit first-operator bootstrap/replay, two-tenant delivery isolation and migration replay passed. Local synthetic database restore passed; fresh-cluster/PITR/file recovery and staging evidence remain pending.
- Human review/staging approval: pending.
