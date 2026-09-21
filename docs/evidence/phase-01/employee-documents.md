# Employee document quarantine control-plane evidence

Date: 21 September 2026
Scope: first P01-05 private-document increment, secure metadata registration and quarantine state.

## Implemented boundary

- Owner and HR users with recent MFA can register PDF, JPEG or PNG metadata up to 10 MB for an existing tenant employee. The strict contract includes category, HR-only or future employee visibility, safe display name, declared media type/size, SHA-256 digest, optional expiry/replacement and an audit reason.
- The API accepts no storage location from clients. The server supplies an opaque random quarantine object key, while API responses exclude that key, the digest, creator identity and audit reason. Tenant-composite employee/replacement references, forced RLS and restricted security-definer functions protect the metadata.
- A separate tenant-scoped idempotency key and canonical request digest return the original record for identical retries and reject changed reuse. Replacement targets must be a non-removed document for the same employee.
- New records remain `awaiting_upload`. No upload or download URL is exposed, and no metadata can mark a file quarantined, clean, rejected or removed. The initial HR list is bounded to the newest 500 metadata records per employee; pagination remains future work. Registration emits payload-free audit/outbox facts acknowledged by the worker.

## Verification

Contract/API tests cover supported formats, the 10 MB bound, strict fields, CSRF and required idempotency keys. Real PostgreSQL tests cover replay/conflict behavior, tenant and employee isolation, recent MFA, owner/HR authorization, direct-table denial, opaque public projections and payload-free audit/outbox records. Migration replay and synthetic database recovery classify and preserve the new table.

All fixtures are synthetic. Object-store upload completion, actual content/digest/type verification, malware scanner integration, clean-file download authorization, replacement activation and retention-controlled removal remain required before this pipeline can handle customer files. An `awaiting_upload` record is metadata only and is never downloadable.
