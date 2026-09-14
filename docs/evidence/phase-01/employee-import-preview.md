# Employee import preview evidence

Date: 14 September 2026
Scope: first P01-05 increment, create-only employee CSV upload and validation preview.

## Implemented boundary

- Owner/HR users with recent MFA can upload at most 64 KiB and 250 non-empty data rows using one fixed, downloadable CSV header. The API accepts the file name, exact UTF-8 text and an audit reason; no multipart or object-storage claim is made.
- The parser supports CRLF, quoted commas, escaped quotes and quoted newlines. It rejects malformed quoting, unexpected headers, invalid dates/codes, missing required values, duplicate employee numbers within the file and spreadsheet-formula-leading values.
- PostgreSQL rechecks the tenant boundary, current duplicate employee numbers, active branch/department/designation codes and existing manager references. Errors are tied to physical CSV row numbers. Cross-file manager references must already exist; same-file manager dependency ordering is not yet supported.
- `employee_import_batches` stores file name, SHA-256 digest, preview revision, counts, status and audit identity/reason. A tenant-scoped idempotency key and request digest make an identical retry return the original preview while rejecting key reuse with a changed request. `employee_import_rows` stores normalized values and safe error codes. Raw CSV content is not retained.
- Both tables use composite tenant references and forced RLS. Application roles have no table access; constrained functions require an active owner/HR membership and recent MFA. Preview creation emits a payload-free audit/outbox fact that the worker can acknowledge.
- The responsive employee-import screen downloads the exact template, reads the selected local CSV in the browser, uploads it through the protected route and shows file/row validation results.

## Verification

Contract tests cover RFC-style quoting, CRLF, blank physical rows, duplicate numbers, formula content, invalid headers and malformed quotes. API and PostgreSQL tests cover strict fields, CSRF, required idempotency keys, selected-tenant context, digest persistence, replay/conflict behavior, active organization resolution, database duplicates, role/MFA/tenant isolation, direct-table denial, row-numbered errors and the invariant that preview creates no employees. Desktop/mobile browser coverage exercises upload and result rendering. Migration and recovery checks classify and preserve both new tables.

All fixtures are synthetic. Confirmation, capacity revalidation, atomic employee creation, committed results and file/object-storage scanning are deliberately left for later P01-05 increments. Preview creation itself is retry-safe; confirmation will require its own commit-level idempotency guarantee.
