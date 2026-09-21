# Employee document quarantine control-plane evidence

Updated: 22 September 2026
Scope: P01-05 private-document metadata registration, local-test upload/scan and authorized HR download increments.

## Implemented boundary

- Owner and HR users with recent MFA can register PDF, JPEG or PNG metadata up to 10 MB for an existing tenant employee. The strict contract includes category, HR-only or future employee visibility, safe display name, declared media type/size, SHA-256 digest, optional expiry/replacement and an audit reason.
- The API accepts no storage location from clients. The server supplies an opaque random quarantine object key, while API responses exclude that key, the digest, creator identity and audit reason. Tenant-composite employee/replacement references, forced RLS and restricted security-definer functions protect the metadata.
- A separate tenant-scoped idempotency key and canonical request digest return the original record for identical retries and reject changed reuse. Replacement targets must be a non-removed document for the same employee.
- New records begin `awaiting_upload`. The initial HR list is bounded to the newest 500 metadata records per employee; pagination remains future work. Registration emits payload-free audit/outbox facts acknowledged by the worker.

## Local-test content path

- Upload mode is disabled by default. `local_test` is accepted only outside production with an absolute private directory and loopback ClamAV endpoint. The owner/HR upload request requires a selected tenant, same-origin CSRF, recent trusted MFA and a matching employee/document record. The request body is raw `application/octet-stream` at `PUT /api/v1/tenants/{tenantId}/employees/{employeeId}/documents/{documentId}/content`.
- The server compares exact declared and received byte lengths, the registered SHA-256 digest and basic PDF/JPEG/PNG leading and terminal signatures, then writes the bytes to a private `0600` quarantine file. Repeated uploads must contain identical bytes. PostgreSQL records `awaiting_upload → quarantined → clean/rejected` transitions, audit facts and outbox events. Only a valid ClamAV INSTREAM clean verdict makes the metadata `clean`; an infected verdict rejects the record and removes the local file. Scanner errors leave it quarantined for an authorized exact-byte retry.
- A local-test GET endpoint authorizes only active owner/HR identities with recent MFA for the same tenant/employee and a clean, unexpired record. It emits an audit fact, rejects a symlink as the final file, verifies size and SHA-256, and serves a generic attachment name with no-store headers. Quarantined, rejected, expired, removed and wrong-employee records do not reveal bytes. Revoked access is rejected on the next request; an already streaming response cannot be retracted. Employee-visible self-service access is not implemented yet.
- There is no object-store adapter or production upload/download mode. A `clean` metadata status alone does not grant file access. Signature checks do not fully parse file formats; malware detection depends on a properly maintained scanner. Local-file retention, backups and recovery are not implemented, so this path must not receive customer files.

## Verification

Contract/API tests cover supported formats, the 10 MB bound, strict fields, CSRF, raw HTTP bytes, no-store attachment responses and required idempotency keys. Real PostgreSQL tests cover replay/conflict behavior, tenant and employee isolation, recent MFA, owner/HR authorization, direct-table denial, allowed scan transitions, clean-only download authorization, expiry, revocation, opaque public projections and audit/outbox records. Unit tests use a synthetic ClamAV protocol server to cover clean, infected and outage results and reject tampered local download bytes. Migration replay and synthetic database recovery classify and preserve the metadata table. A real ClamAV process and a combined database/file recovery drill have not been exercised.

All fixtures are synthetic. A production object-store adapter, real scanner operations, file recovery, employee-visible self-service authorization, replacement activation and retention-controlled removal remain required before this pipeline can handle customer files. An `awaiting_upload` or `quarantined` record is never downloadable.
