# Synthetic local employee document upload

This path is disabled by default and rejects `local_test` when `NODE_ENV=production`. It must not receive customer documents. No production object storage, file backup/restore or retention controls exist yet.

For an isolated synthetic test, start a locally managed ClamAV daemon bound to `127.0.0.1:3310`. Set `DOCUMENT_STORAGE_MODE=local_test`, `DOCUMENT_QUARANTINE_DIR` to an absolute private directory, and optionally `DOCUMENT_CLAMD_HOST=127.0.0.1` and `DOCUMENT_CLAMD_PORT=3310`. The daemon and its signature update process are operator-managed; this repository does not install or verify either one.

An authorized owner/HR user with a selected tenant and recent MFA first registers document metadata, including exact byte length and SHA-256 digest. The client then sends those same bytes as `application/octet-stream` to `PUT /api/v1/tenants/{tenantId}/employees/{employeeId}/documents/{documentId}/content`, with the normal session cookie, Origin and CSRF header. Only the server chooses the private storage key. A scanner outage returns a service error and leaves the document quarantined; retry the exact same bytes after scanner recovery. A scanner rejection marks the metadata rejected and removes the file.

For clean, unexpired documents, the same authorized owner/HR role can request `GET /api/v1/tenants/{tenantId}/employees/{employeeId}/documents/{documentId}/content`. An employee with an active linked account can list only their own clean, unexpired employee-visible documents at `GET /api/v1/tenants/{tenantId}/me/documents` and retrieve one at `GET /api/v1/tenants/{tenantId}/me/documents/{documentId}/content`. The API checks access on every request and verifies the stored size and digest before serving bytes as an attachment. It does not issue a reusable storage URL.

Do not treat database-only restore as document recovery. The local quarantine directory needs its own future backup and reconciliation design before production storage can be enabled. See [implementation evidence](../evidence/phase-01/employee-documents.md).
