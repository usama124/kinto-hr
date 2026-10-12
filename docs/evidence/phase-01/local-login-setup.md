# Persistent local administrator and company login

12 October 2026 · Local synthetic verification only. No production acceptance.

## Change

Added an explicitly confirmed Linux/local-test setup command and persistent loopback Keycloak/Mailpit services. It reuses the reviewed LoA password/TOTP flow without widening the disposable test wrapper's realm restriction, verifies the provider subject before guarded operator bootstrap, enables local owner/employee/admin invitation delivery and read-only identity checks, and uses dedicated auth Redis state with durable logout handling.

Secrets, realm imports, provider data, initial credentials and TLS keys stay in ignored private local files. Setup preserves unrelated `.env` settings, snapshots the original file, refuses unrelated providers/operators and cannot target a production database. Local browser HTTPS keeps Secure cookies without altering machine trust or disabling global TLS verification. Development request logging is disabled to avoid emitting callback query strings.

## Verified on this machine

- `pnpm verify`: formatting, lint, types, 488 unit tests with coverage, six isolated development-launcher tests, planning links and readiness manifest integrity passed with the localhost access required by the existing test suite.
- Real Chromium: administrator password login, required TOTP enrollment, platform authorization, protected company form, company creation and initial-owner invitation delivery to Mailpit passed.
- Real Chromium: owner email verification, password/profile/TOTP setup, exact-subject owner activation and company organization workspace passed. Secure/HttpOnly/SameSite=Lax session cookie assertions passed.
- Local password-recovery email capture, absence of registration, rejected direct password grant, API readiness and required human MFA enrollment passed. This check sent a reset email; it did not change the administrator password.
- Repeat setup preserved the same realm and first operator. Restarting the provider preserved the operator and demo-owner accounts; repeat subject verification/bootstrap succeeded.
- Verification-only MFA credentials were removed and provider sessions logged out. Human users must enroll their own authenticators. A synthetic **Local Demo Company** remains for manual checking; its initial owner credentials are private.

The initial sandboxed verification could not bind test sockets. The successful run used authorized loopback access; tests were not skipped to make verification pass. Private machine reports remain under `.local/auth/` and are not committed.

## Remaining boundary

This did not run the complete `pnpm verify:full` production-style acceptance sequence. The existing disposable Keycloak suite remains separate; the local flow was verified against the actual pinned provider and browser here. Production provider PostgreSQL/backups, mail delivery, HTTPS, secrets, MFA recovery, callback availability/reconciliation, abuse protections, scanner/storage operations and security review remain open. Attendance/payroll scope and roadmap acceptance are unchanged.

See [local login operations](../../operations/local-login.md), [authentication operations](../../operations/authentication.md) and [Keycloak verification](../../operations/keycloak.md).
