# Company leave policy workspace

13 October 2026 · Local/synthetic UI verification only.

## Delivered

`/leave-policies` is available through the workspace navigation. Owners create company-wide leave types/initial drafts, create subsequent drafts and confirm publication. HR can read types, effective settings and policy history, but receives no write controls. Employees and unrelated roles are denied before policy reads.

All quotas, pay treatment, leave-year start, holiday/rest treatment and review reasons are explicit. No statutory quotas or calendar treatment are guessed. Supported grants remain annual upfront; a monthly hard usage cap is not accrual or rollover. Existing type codes are read-only and sourced from validated metadata. Future publications count toward the latest published base even when the applicable current policy is older. Displayed quotas are configured limits, not employee balances.

Type and policy keyset pages are independent. The current policy is supplied by the backend's complete-history resolver rather than inferred from a visible page. The client validates shared schemas, selected company/type/code, date, interval/current-state consistency, version uniqueness, ordering and cursor boundaries before display. Review uses the validated immutable snapshot; the backend remains the publication/version/permission authority.

Session/company/identity/owner-role checks run before commands and after reads/writes. Lost access clears data, form/review values and pending commands. Loading/errors remove old company projections rather than retaining a stale page. Narrow wrapping styles support maximum-length names/codes on mobile without affecting existing timing controls.

## Retry and publication safety

Mutations bind the original actor, company, type/policy, UUID key and parsed payload. Uncertain transport, server or receipt outcomes retain that exact attempt in component memory, block new changes and permit explicit retry with freshly fetched session CSRF. Same-context metadata refresh preserves the attempt; company, identity or owner loss discards it. No payload, key, session token or CSRF is written to browser storage.

Strict receipt validation refuses another type/policy/version. A successful or rejected command requires metadata refresh before another write. Stale/past drafts cannot be published through the form; the SQL boundary independently refuses stale/backdated/competing publications and unsupported leave-year changes. Both draft creation and publication require explicit confirmation and reasons. Closing or reloading the page loses an uncertain request; the user must reconcile history before creating another command.

## Limits

This adds configuration UI only. It does not submit/approve employee leave, create quota reservations or ledger entries, apply salary/Annual-leave absence fallback, close attendance periods or calculate payroll. Those availability flags remain false in shared API responses and are rejected if unexpectedly advertised. Production/provider/hardware/privacy/payroll gates are unchanged.

The browser cases use synthetic typed API/session fixtures against the actual built web/API processes. They do not replace the real SQL authorization/replay/restore proof in the [backend evidence](leave-policy-api.md) and do not claim live provider or company acceptance.

## Verification

Completed locally on 13 October 2026:

- `pnpm verify`: formatting, lint, types, 492 unit tests with coverage, six isolated development-launcher tests, 244 planning links and readiness-manifest integrity passed. Production acceptance remains false.
- `pnpm build`: API, web (including `/leave-policies`) and worker builds passed.
- Targeted browser regression: 96 desktop/mobile cases passed across leave, timing, organization setup, navigation and responsive workspace behavior.
- Final `pnpm test:e2e`: the complete 320-case desktop/mobile suite passed, including 48 leave-workspace cases. Coverage includes type/draft/publication commands, HR read-only access, explicit/invalid quotas and year dates, future-version bases, independent pages/current policy off-page, malformed/foreign projections, access loss, exact uncertain create/publication retries, fresh CSRF, wrong receipts, rejected versions, actor/company/role changes during reads/writes/retries and maximum-length mobile wrapping.

The first targeted run found overly strict select label locators; corrected accessible combobox selectors passed in subsequent targeted and full runs. No failed cases were skipped in the successful final suite. Existing employee, account, document, entitlement, device, connector, mapping and timing screens were included in the full run. Private browser/runtime logs and reports stay ignored.

Browser verification used auth-disabled test server startup and synthetic session/API fixtures without rewriting `.env`. No SQL/API/schema/auth behavior changed, so database migration, SQL integration/recovery and disposable real-provider tests were not rerun for this UI increment. The full `verify:full` release sequence was not run; live provider, hardware, payroll and production acceptance remain separate gates.

## Next

Atomic request reservation/ledger and approvals using authoritative employee eligibility, work calendars, effective policy snapshots and period locks. Then leave/attendance reconciliation and company-configured absence settlement before payroll consumes closed inputs.
