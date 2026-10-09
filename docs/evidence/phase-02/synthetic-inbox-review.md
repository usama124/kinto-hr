# Synthetic inbox review and mapping preview — 10 October 2026

Status: read-only internal local preparation. P02-01/P02-02 remain partial and production acceptance is false.

## Implemented boundary

The existing synthetic inbox class now exposes bounded review and mapping-preview methods. It remains unmounted in HTTP and rejects production/remote/ordinary database configuration. Migration 56 adds two constrained SECURITY DEFINER functions, independently restricted to synthetic `kinto_test*` databases and current owner/HR membership with MFA. Employees, foreign users, stale MFA, revoked membership and suspended companies are denied. Worker/dispatcher/PUBLIC cannot execute the functions; ordinary runtime roles still cannot read raw inbox tables directly. No table or write grant is added.

Review selects one company's device, including retired device history, with UUID keyset pagination (default 25, maximum 50). Each page reads at most limit plus one rows. Returned records contain canonical event/device UUIDs, sanitized source fields, quarantine code and creation time. Transport aliases, connector UUIDs and deduplication keys are not exposed. Source strings and local timestamps remain exact. Pagination is not a historical snapshot: concurrently appended UUIDs may sort before an existing cursor; refreshing starts a new traversal.

## Mapping previews are not processing

Preview loads the raw event using company/device/event scope and derives the source user string from persisted payload. Callers cannot replace source user ID, employee identity or mapping authority. It examines full current mapping history, not a displayed page, using case-sensitive source IDs and half-open effective intervals. It returns mapped/unmapped/ambiguous status plus mapping UUID/version and employee UUID where exactly one mapping matches.

The caller must supply an explicit offset-aware preview instant between 2000 and 2100. It is normalized to UTC but is not inferred from the device timestamp. Every result labels `timeBasis: operator_supplied_unverified`, `clockVerified: false`, `sourceIdentityVerified: false` and `attendanceProcessingAvailable: false`. The supplied instant may differ from the recorded local time: this is an operator what-if lookup, not a verified event time or employee assignment. A matched preview must never be counted as attendance, clear quarantine or become payroll input.

No mutation/promotion, exception approval, source/clock verification, correction/reprocessing, leave deduction, period locking or payroll effect is implemented. Unsupported/unmapped exact source strings are not coerced or guessed. Canonical rows, existing receipts, audit/outbox counts and mapping history remain unchanged by review/preview.

## Verification

310 unit/API tests and 261 integration tests pass, including six new review integration cases and contract validation of strict flags, payloads, bounds and caller overrides. Coverage thresholds, formatting, lint, typechecks, documentation links and readiness integrity pass. Isolation remains verified for 52 business tables. Clean baseline/upgrade/replay verification covers 56 migrations.

The isolated synthetic SQL restore preserved review access and mapping previews across the effective-time boundary without changing the restored snapshot. Private evidence: `.local/recovery/63ec5162b8a14f86875cce6709f2ece7/report.json`. This is not independent-cluster recovery, real device clock/source proof or customer production approval. API, web and worker builds passed. Browser/provider and built-worker runtime acceptance were not rerun; no public HTTP route, UI or worker behavior changed.

Next bounded work: opt-in synthetic owner/HR review HTTP boundary, followed by its workspace. Production machine admission/rotation, protected host credentials, actual K50/SDK/source/reset/clock proof, safe reprocessing and finalized-period safeguards remain gates. Normalization, leave accounting and payroll remain separate work.
