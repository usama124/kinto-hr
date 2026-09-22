# Read-only employee self profile

Date: 22 September 2026
Scope: first P01-05 employee profile self-service increment.

An employee with an active tenant membership, durable employee identity link and recent trusted MFA can read `GET /api/v1/tenants/{tenantId}/me/profile`. The database derives the employee ID from the link; the client cannot select another employee. The response includes core employment identity and, if recorded, the employee's own contact and emergency-contact fields with a version for future change requests. It excludes CNIC, residential address, compensation, bank details, assignment history and all other employees' records. Terminated or archived employees are not served even if a stale membership remains active.

The function is owned by the restricted control role. The application role cannot directly read employee identity links or private details. Selected-tenant session enforcement, active identity/membership checks, recent MFA and a strict response schema all apply. No write endpoint or change request is included in this increment.

Synthetic PostgreSQL tests cover linked/unlinked users, tenant mismatch, recent MFA, missing contact details, own contact projection and revoked membership. HTTP tests cover selected-tenant and session requirements. Migration replay and database recovery are verified separately. Profile change requests, HR approval/rejection, UI and deployment encryption review remain open.
