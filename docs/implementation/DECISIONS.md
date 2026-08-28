# Decisions, external dependencies and source register

Version 1.0 · 28 August 2026 · See [roadmap](README.md)

## Status vocabulary

Confirmed means the product owner supplied the requirement. Working default means implementation may use the proposed choice in synthetic/local work; it is not customer approval. Open means evidence or an owner decision is still needed. Gates identify only the affected work: an open payment provider does not block employee CRUD, and missing hardware does not excuse declaring hardware support verified.

## Confirmed requirements

- **C01:** first market Pakistan.
- **C02:** first device target ZKTeco K50; firmware, ownership/access and current connected software not yet supplied.
- **C03:** employee, biometric attendance and payroll core; multi-company SaaS considered the recommended direction accepted for this planning baseline.
- **C04:** selected clients can receive free access independently of ordinary paid subscription plans; free capacity starts at five employees with paid capacity bands.

## Working implementation decisions

- **D01 — architecture:** Next.js/TypeScript, NestJS, PostgreSQL, Prisma plus SQL, Redis/BullMQ, private object storage, modular monolith. Owner: engineering. Gate: P00-04 checks versions, ORM/RLS and licenses before production dependency lock.
- **D02 — identity:** OIDC; Keycloak for local/staging integration, provider-neutral business permissions. Owner: engineering/operator. Gate: identity provider, MFA/recovery, secret management and operating cost approved before P01 staging with real users.
- **D03 — product scope:** one employer per tenant, monthly salaries, PKR, Asia/Karachi, English, fixed and overnight shifts, five-seat Free and paid 20/50/100/250 capacities. Owner: product. Gate: confirm pilot applicability in P00-01; unsupported employment models block those customers, not synthetic development.
- **D04 — deployment:** shared cloud, local K50 connector, no on-premises v1. Owner: product/operator. Gate: region/vendor/data location and budget before hosting live data. Recovery/performance targets in the shared spec require costing and tests.
- **D05 — payments:** manual invoice plus independently approved bank-transfer reconciliation is the launch baseline. Owner: product/finance. Automated recurring card collection is conditional; do not call manually renewed access automatic charging.
- **D06 — payroll separation:** distinct preparer and approver accounts for production finalization; owners can receive explicit roles but cannot approve a run they prepared. Owner: product/payroll reviewer. Gate: pilot staffing supports this; relaxing it needs a documented policy change, not a hidden bypass.
- **D07 — expansion:** Phase 5 is expenses and asset custody; ATS, performance, mobile, international payroll and on-premises remain deferred requests.

## Open external decisions and safe fallbacks

- **E01 — K50 evidence.** Owner: product/customer supplies authorized device access, exact model/firmware, communication settings, existing software and available host OS; engineering verifies SDK, licensing, restart/replay and performance. Blocks P00-02 hardware completion and P02 live K50 release. Safe work: protocol contract and explicitly synthetic simulator. Never use a K50 Pro specification as proof for the K50.
- **E02 — Pakistan payroll applicability.** Owner: payroll specialist plus pilot employer. Identify provinces/territories, employee categories, pay/proration/overtime rules, applicable deductions/contributions, annual tax treatment, opening balances, final settlement and expected reports. Supply effective authoritative sources and independently calculated fixtures. Blocks P03 real payroll finalization. Safe work: generic decimal engine with conspicuously synthetic rules; missing rules are errors, never zero-tax defaults.
- **E03 — pilot data and privacy.** Owner: product/customer. Permission to use data, permitted hosting, privacy notices, access, retention, export and deletion/legal-hold terms. Blocks any live customer data in any environment. Safe work: invented fixtures with no real identifiers.
- **E04 — hosting/operations.** Owner: operator/product. Approve vendor, region, budget, identity/email/storage/backup services, availability/recovery targets and incident contacts. Blocks production provisioning. Safe work: local containers and declarative templates without purchased resources.
- **E05 — seller and billing.** Owner: product/finance. Confirm registered entity, settlement account, invoicing/tax requirements, PKR prices, due dates, grace/retention terms, refunds and manual reconciliation staff. Blocks issuing real invoices or paid launch. Safe work: draft invoices and simulation; no assumed tax rate.
- **E06 — automated provider.** Owner: product/finance and provider. Verify merchant eligibility, currency, hosted checkout, recurring mandates, signatures, refunds, settlement and sandbox credentials. Blocks automatic collection only; approved manual subscription billing can launch without it.
- **E07 — customer scope.** Owner: product. First industry, employee count, branches, supported province and pilot dates. Defaults are small monthly salaried employers, not factories/piecework/multi-country employers. Blocks commitment to workflows outside the default.
- **E08 — SDK/connector distribution.** Owner: engineering/vendor contact. Confirm lawful SDK usage and installer redistribution, host architecture, code signing and update strategy. Blocks distributing a production installer. Safe work: adapter interface and tests without bundling unlicensed binaries.
- **E09 — retention and support.** Owner: product/legal/customer/operator. Approve record retention, suspension notices, export window, backup expiry, restoration and support charges. Blocks automatic purge and general commercial release. Safe default: no automatic business-record purge; synthetic artifacts may be cleaned by their documented test lifecycle.

## Change control

### 28 August 2026 — initial engineering baseline

Under the product owner's implementation request, engineering selected Node 22.23.2, pnpm 10.28.2, TypeScript 5.9.3, Next.js 16.3.3, React 19.2.8, NestJS 12.0.1, PostgreSQL 16 and Prisma 6.19.3 for the local foundation. Exact dependencies, actions and database image digest are locked in the repository. Prisma remains on the tested v6 access layer; adopting v7 requires a separate adapter/migration check. Identity, worker, storage and hosting remain unprovisioned. Local compatibility is demonstrated by [foundation evidence](../evidence/phase-01/foundation.md), not by version selection alone. Production security/operations approval is pending.

The Prisma tooling dependency `@prisma/config>deepmerge-ts` is narrowly overridden to 8.0.0 for [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). The [upstream release](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0) changes Map merging; the current project uses schema-based configuration and no custom Map configuration. Client generation and migration replay were rerun successfully. Reassess the override when upgrading Prisma; do not remove it without an audit and compatibility checks.

Changes to money rules, auth/tenant boundaries, commercial state, supported device compatibility or hosting location require an entry stating decision, reason, alternatives, affected phase/tests, approver and effective date. Do not edit previous payroll snapshots or plan contracts to implement a new decision. After a meaningful scope change, re-estimate remaining phases.

## Source register

These sources were consulted for the planning package on 28 August 2026. They support specific technical facts, not a declaration that the product is compliant, compatible or implemented. Verify version-specific behavior again during the relevant spike.

- [ZKTeco K50 product page](https://www.zkteco.eg/KSeries/K50): lists TCP/IP and USB-host. Does not establish the actual unit's SDK support, cloud push, storage behavior or successful integration.
- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): row policies and owner/privileged-role exceptions. Implementation still needs real pooled-connection tests.
- [PostgreSQL numeric types](https://www.postgresql.org/docs/current/datatype-numeric.html): exact numeric arithmetic. Project rounding and statutory treatment require their own specification.
- [NestJS queues](https://docs.nestjs.com/techniques/queues): BullMQ integration. Durable outbox and idempotency are additional design requirements here.
- [Keycloak OIDC integration](https://www.keycloak.org/securing-apps/oidc-layers): endpoints and authentication flows. Identity deployment/MFA configuration remains to be validated.
- [FBR Income Tax Ordinance collection](https://www.fbr.gov.pk/Categ/Income-Tax-Ordinance/326/1000): starting point for authoritative legislation. No current tax brackets or universal employer obligations are asserted in this package. Obtain the relevant effective instrument and other applicable authorities during P00/P03 review.

No package/version compatibility, live tax rates, payment-provider eligibility or K50 hardware test result is claimed merely because a source URL is listed.
