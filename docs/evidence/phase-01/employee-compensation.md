# Employee compensation evidence

Date: 14 September 2026  
Scope: P01-04 effective-dated PKR monthly compensation capture and history.

## Implemented boundary

- `compensation_agreements` provides one versioned agreement per employee. Stable `salary_components` codes and immutable `compensation_component_versions` retain each full effective-dated snapshot.
- Every revision contains exactly one monthly basic salary and may include typed fixed recurring allowances and deductions. Amounts use PostgreSQL `numeric(15,2)` and bounded decimal-string contracts; floating-point money is not used.
- A revision must be later than the prior revision. The command closes the prior interval, retains its values and rejects stale or repeated dates. A database trigger rejects overlapping component intervals even outside the command.
- `payroll_preparer` has compensation read/write and `payroll_approver` has read-only access. Owner, HR and employee roles have no implicit salary access; a designated HR user must be explicitly assigned the payroll role through audited membership administration. Recent MFA is required.
- The public employee projection exposes only `payrollSetup: complete|incomplete`, never amounts or components. Audit/outbox records contain employee references and agreement versions without salary values.
- This increment performs no payroll calculation, statutory interpretation, finalization, payslip generation or salary payment.

## Verification

Contract, domain, API and PostgreSQL tests cover typed components, exact basic-salary cardinality, money validation, initial entry, a future increment, retained prior values, role/MFA/tenant separation, read-only approval access, optimistic concurrency, duplicate-date rejection, direct-table denial and sanitized public/audit/event projections. Migration replay and synthetic backup/restore include all three compensation tables.

All fixtures are synthetic. Pakistan payroll rules, proration and statutory treatment remain external review gates before Phase 3 or any live payroll use.
