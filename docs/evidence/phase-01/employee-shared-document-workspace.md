# Employee shared-document workspace evidence

Updated: 1 October 2026
Scope: P01-05 employee document list and download UI over the existing self-service APIs.

## Implemented boundary

- `/my-documents` requires a selected company and employee role before requesting `/me/documents`. No employee identifier input, roster request or HR document mutation is available.
- The server derives the employee from the authenticated identity and remains authoritative for clean status, employee visibility, expiry and replacement activation. The browser strictly parses the shared projection and rejects a non-clean or HR-only result without displaying it.
- Downloads use the existing `/me/documents/:documentId/content` authorization boundary and no-store requests. A generic UUID filename avoids interpreting metadata as a filesystem path. No file or session data is saved to browser storage.
- A denied or expired-session download removes displayed metadata and switches to the access notice. Missing/replaced files and storage outages display a retry/refresh message without granting access. Empty lists, malformed projections, unavailable services and missing company selection have explicit states.
- Employees cannot register, upload, replace or change document visibility. HR remains responsible for sharing and corrections. The page uses the existing responsive document styles and sidebar navigation.

## Verification

Production build and `pnpm verify` cover the new route, types, lint, formatting and existing unit/API regressions. Desktop/mobile Playwright journeys cover shared-document download, storage failure, revoked access, empty and malformed responses, role/session/company gates and viewport containment. The existing real PostgreSQL employee-record tests cover identity-derived listing and download permissions, hidden/expired/quarantined documents and replacement authorization.

Checks passed on 1 October 2026:

- `pnpm verify`: formatting, lint, types, 159 unit/API tests and documentation links.
- `pnpm build`: API, web (including `/my-documents`) and worker production bundles.
- `pnpm test:integration tests/integration/employee-records.test.ts`: all 9 tests.
- `E2E_WEB_PORT=3100 pnpm test:e2e`: all 40 desktop/mobile tests. Port 3100 avoids an existing service on 3000; the lifecycle fixture now uses a fixed browser clock so its future termination date does not expire as the calendar advances.

Fixtures and files are synthetic. This is a local implementation; production object storage, scanning, retention/legal holds, file recovery and approved staging remain required. No database migration or new authorization grant is introduced.
