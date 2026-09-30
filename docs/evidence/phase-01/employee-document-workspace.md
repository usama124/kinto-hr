# Employee document manager workspace evidence

Updated: 30 September 2026
Scope: P01-05 responsive owner/HR document manager over the existing private employee-document API and local-test content path.

## Implemented boundary

- A selected-company owner or HR administrator can open `/documents`, choose an employee from the strictly parsed roster and list that employee's document metadata. Employee, payroll-only, signed-out and unselected-company sessions do not receive a document-management workspace.
- Registration accepts one PDF, JPEG or PNG up to 10 MB, category, HR-only or employee-visible visibility, optional expiry, an optional authoritative replacement target and a reason. The browser computes SHA-256, creates a memory-only idempotency key and sends no client-selected storage key or scan result.
- After metadata registration, the workspace sends the exact raw bytes through the CSRF-protected quarantine endpoint. Scanner/storage failure leaves the metadata visible as pending. The same page supports selecting the exact registered file again for an `awaiting_upload` or `quarantined` record after refresh; the server remains authoritative for digest, signature and scan verification.
- Only authoritative clean documents expose download. A clean linked candidate is labelled awaiting activation and cannot download. HR supplies a separate activation reason; successful activation refreshes the list, exposes the winner and displays the retained retirement reason on the superseded record.
- The replacement selector derives authoritative targets from server metadata, but PostgreSQL also enforces this independently. Migration `202609300002_document_replacement_authority` rejects attempts to supersede a clean candidate that has never won activation, preventing replacement chains from publishing parallel document histories.
- The page explains that the local-test path requires private local storage and loopback ClamAV, production rejects that mode, and logical retirement does not physically purge retained bytes.

## Verification

The production Next.js build includes `/documents`. Playwright exercises registration, browser digest submission, raw upload/clean transition, replacement activation, retirement display, authorized download and viewport containment on desktop and 360 px mobile layouts. Real PostgreSQL tests reject activation over a pending replacement candidate and retain the prior concurrency, idempotence, authorization, old-download denial and audit/outbox coverage.

All files and identities are synthetic. This workspace does not make local file storage production-ready. Production object storage, deployed malware scanning, file backup/restore and approved retention/legal-hold purge controls remain required.
