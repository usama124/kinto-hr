# Synthetic attendance ingestion contracts and preflight

Date: 4 October 2026. Starting main: `6c39371` (PR 59). Work branch: `codex/attendance-ingestion-contracts`.

## Delivered boundary

This is preparatory P02-01/P02-02 work, not a functioning attendance module. Shared strict schemas allow attendance identifiers, original local timestamps, optional direction and bounded work code only. Unknown fields, including templates/photos and caller-selected tenant/timezone, are rejected. User IDs remain strings with leading zeros; UUIDs are canonicalized to lowercase. Timestamp precision is seconds with optional one to three decimal places; offsets are forbidden because configured device timezone will be server authority.

The pure internal API preflight accepts only an active, assigned device/adapter scope. Its scope type is not authentication: a future registry and machine credential guard must supply fresh trusted scope. Bounds are 500 events and 1,000,000 serialized UTF8 bytes. A future HTTP route must separately enforce actual raw body bytes, including whitespace, before parsing.

Malformed records receive static unstored rejection codes without returning sensitive values. Every repeated transport UUID in a batch is rejected, including when one row is malformed. Transport keys include tenant/connector/event UUID. A configured, hardware-verified vendor identity would use tenant/device/reset epoch/source ID, surviving connector replacement. No K50 source identity has been verified. Unverified identities always require review, even when a source ID is supplied; identical-time punches are never silently collapsed. Contradictory source IDs reject all conflicting rows regardless of order. Identical source rows remain candidates pending transactional storage deduplication.

Receipt schemas describe stored/duplicate/durably quarantined/unstored states and ordered indexes only. No receipt is emitted by preflight. No database write, outbox event, queue deletion, durable acknowledgment, employee mapping, UTC conversion or attendance/payroll effect exists here. Hashes are linkable metadata, not anonymization.

## Verification

Targeted contract/preflight tests cover valid rows, strict sensitive-field rejection, local dates/precision, per-row failures, scope spoofing, bounds, circular/BigInt input, stable retries, connector replacement, reset epochs, legitimate same-time events, unverified identities, conflicting source identities and case-equivalent UUIDs. These use synthetic fixtures only.

Final local checks passed:

- `pnpm verify`: formatting, lint, API/web type checks, 203 unit/API tests across 28 files, coverage thresholds, 10 planning documents/166 local links and readiness-manifest integrity.
- New preflight and attendance contract modules have 100% measured statement/branch/function/line coverage; this is synthetic evidence, not proof of hardware behavior or durable deduplication.
- `pnpm build`: API, web and worker builds passed.
- `git diff --check`: passed.

The initial verification found two unused test variables; these were fixed before the successful complete rerun. No hardware, migration, database recovery, browser or provider verification was rerun for this pure non-mounted increment. There are no schema or UI changes. Foundation readiness still reports `productionAccepted: false`.

## Remaining work

Next bounded step: tenant-scoped device registry and server-side provisioning authority. Then machine enrollment/authentication, effective employee mappings, transactional raw-event/exception inbox, durable replay acknowledgments and outbox processing. K50 hardware evidence, adapter/SDK distribution approval, local connector queue/restart/recovery, timing calculations, leave quotas/settlement and period closure remain pending. Foundation production review gates remain unchanged.
