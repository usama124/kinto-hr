# Employee checklist evidence

Date: 14 September 2026  
Scope: P01-04 basic onboarding and offboarding checklist workflow.

## Implemented boundary

- `checklist_tasks` binds every task to one tenant, employee and immutable employment period. A stable task code is unique inside that period; onboarding and offboarding history therefore remains attached to the correct service period after archive or rehire.
- Each task records its title, active owner/HR assignee, due date, pending/completed status, optimistic version, completion time and completing identity. Create and complete commands require recent MFA and an active owner or HR membership.
- An onboarding task is accepted only for a planned or active current period. Offboarding tasks require a scheduled final working date and cannot be due after it. Task dates cannot precede the period joining date.
- Scheduling an approved termination atomically creates the pending `FINAL_SETTLEMENT_REVIEW` offboarding task assigned to the scheduling owner/HR user. This is a workflow placeholder for Phase 3 calculation and approval; it does not calculate or pay a final settlement.
- Mutations emit reasoned audit facts and payload-free durable outbox events. Runtime roles cannot access the table directly; constrained security-definer functions, forced RLS and composite tenant foreign keys enforce the boundary.
- The employee workspace can load tasks, create a task assigned to the signed-in owner/HR user and complete pending work. Phase 5 asset custody remains separate.

## Verification

Contract, permission, API and PostgreSQL tests cover normalization, strict request fields, creation, duplicate codes, listing, completion, stale versions, recent MFA, role and tenant isolation, direct-table denial, and automatic final-settlement task creation. Migration checks cover clean deployment, legacy composite-key compatibility, backfill and replay. Synthetic database recovery includes checklist rows.

All fixtures are synthetic. Checklist notifications, reusable templates, asset clearance and Phase 3 final-settlement calculation are not implemented by this increment.
