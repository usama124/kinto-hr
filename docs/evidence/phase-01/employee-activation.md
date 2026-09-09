# Complete employee activation evidence

Status: locally verified · 9 September 2026 · P01-04 increment

## Delivered boundary

- `POST /api/v1/tenants/{tenantId}/employees/{employeeId}/activate` accepts only an expected version and audit reason. Tenant, actor, target state and capacity are server-controlled.
- An active owner or HR administrator with recent trusted MFA can activate only a complete monthly-salaried draft. The command rechecks its planned employment period, active organization references and either an active manager or documented top-level exception.
- Activation obtains the tenant capacity lock, resolves the current subscription/grants/override from database time and counts employees without logins. The final available seat cannot be allocated twice.
- Employee status, employment-period status, version, reasoned audit event and durable `employee.activated.v1` outbox event commit atomically. Stale, repeated, cross-tenant, incomplete, over-capacity and unauthorized requests change nothing.
- The employee workspace exposes the explicit action only for drafts, requires a reason and reloads the authoritative roster after success. Joining date remains historical input; activation reserves capacity immediately.

## Verification

- Contract/API tests cover strict mass-assignment rejection, selected-tenant binding, CSRF, recent-MFA derivation and the returned active state/version.
- PostgreSQL tests cover owner/HR authority, employee and stale-MFA denial, tenant isolation, inactive organization references, incomplete legacy records, stale/repeated activation and direct-table-write denial.
- A concurrent one-seat test produces exactly one success, one `CAPACITY_REACHED` result and one activation audit event.
- Migration verification applies all 19 migrations to clean, upgrade and replay databases. Recovery activates a complete employee in each synthetic tenant and preserves both active employment periods and activation events.
- Desktop and mobile browser checks create and explicitly activate an employee without exposing salary or private data.

## Remaining P01-04 work

Scheduled termination, archive, coordinated login revocation and rehire periods remain next. Private details, permission-separated compensation history and onboarding/offboarding checklists are also incomplete. This preview is not approved for customer data.
