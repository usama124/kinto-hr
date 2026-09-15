# Employee import validation and confirmation evidence

Date: 15 September 2026
Scope: P01-05 create-only employee CSV upload, validation preview and atomic confirmation.

## Implemented boundary

- Owner/HR users with recent MFA can upload at most 64 KiB and 250 non-empty data rows using one fixed, downloadable CSV header. The API accepts the file name, exact UTF-8 text and an audit reason; no multipart or object-storage claim is made.
- The parser supports CRLF, quoted commas, escaped quotes and quoted newlines. It rejects malformed quoting, unexpected headers, invalid dates/codes, missing required values, duplicate employee numbers within the file and spreadsheet-formula-leading values.
- PostgreSQL rechecks the tenant boundary, current duplicate employee numbers, active branch/department/designation codes and existing manager references. Errors are tied to physical CSV row numbers. Cross-file manager references must already exist; same-file manager dependency ordering is not yet supported.
- `employee_import_batches` stores file name, SHA-256 digest, preview revision, counts, status and audit identity/reason. A tenant-scoped idempotency key and request digest make an identical retry return the original preview while rejecting key reuse with a changed request. `employee_import_rows` stores normalized values and safe error codes. Raw CSV content is not retained.
- Both tables use composite tenant references and forced RLS. Application roles have no table access; constrained functions require an active owner/HR membership and recent MFA. Preview creation emits a payload-free audit/outbox fact that the worker can acknowledge.
- The responsive employee-import screen downloads the exact template, reads the selected local CSV in the browser, uploads it through the protected route and shows file/row validation results.
- Confirmation requires the exact file digest and preview revision, a separate tenant-scoped idempotency key, recent MFA and an audit reason. It rechecks current duplicates, active organization references, active existing managers and effective subscribed capacity under the shared tenant locks.
- A successful confirmation atomically creates every employee as active and monthly-salaried with an active first employment period and initial assignment. It records the ordinary draft/activation lifecycle facts plus one import-commit fact, links each result row to its employee and stores only safe IDs/statuses. No compensation, login account or payment is inferred.
- Changed references reject the whole batch, increment its validation revision and persist row errors without creating employees. Insufficient capacity leaves the ready batch and all employee records unchanged so the same authorized request can be retried after capacity is resolved. Successful and validation-failed retries return the persisted result.

## Verification

Contract tests cover RFC-style quoting, CRLF, blank physical rows, duplicate numbers, formula content, invalid headers, malformed quotes and strict confirmation input. API and PostgreSQL tests cover CSRF, independent idempotency keys, selected-tenant context, digest/revision binding, successful and rejected replay behavior, active organization resolution, database duplicates, capacity rejection, role/MFA/tenant isolation, direct-table denial, row-numbered errors and atomic active-employee creation. Desktop/mobile browser coverage exercises upload, preview, confirmation and committed-result rendering. Migration and recovery checks preserve committed batches and linked employee results.

All fixtures are synthetic. Same-file manager dependency ordering, private documents/object-storage scanning, employee self-service and reports remain later P01-05 increments. This workflow is not approved for customer data until the wider operational and staging gates pass.
