# Persistent local login

Local development only, Linux and Docker required. Use synthetic company and employee data. This is separate from the disposable `pnpm test:keycloak` verification and is not a production Keycloak deployment.

## One-time setup

First follow the root README database initialization steps. Stop an existing `pnpm dev` session before starting the authenticated application. Then, from the repository root:

```bash
pnpm local:auth:setup --confirm-local-setup
pnpm local:dev
```

Setup creates a dedicated persistent Keycloak realm using the reviewed password/TOTP LoA flow, confidential PKCE client, separate provisioning and read-only identity-status service accounts, local email inbox and localhost certificate. Registration and password grants remain disabled. It verifies the provider subject before running the guarded first-operator bootstrap. It refuses non-local/non-test databases, unrelated providers and replacement of an existing operator. It updates only authentication settings in the ignored root `.env`; unrelated database and worker settings are preserved. Fresh terminal exports are recommended, although `local:dev` explicitly uses the current file values.

## Administrator login

1. Open [Kinto login](https://localhost:3443/login). Accept the self-signed **localhost** certificate warning. No machine trust-store change or global TLS bypass is installed; Secure cookies remain enabled.
2. Open `.local/auth/credentials.txt` locally. Use the **Kinto** username and initial password, not the Keycloak console credentials. Do not share or commit this file.
3. On first login, scan the displayed QR code with an authenticator app and enter its current code. Enter a fresh code on subsequent logins.
4. Open [company onboarding](https://localhost:3443/platform/companies), fill company name, initial owner email, access model and employee package, and click **Create company**. A platform administrator does not automatically receive a company membership.

## Company owner login

1. Open the [local email inbox](http://127.0.0.1:8025). Keycloak invitation and password-reset email is captured here; **nothing is sent to external email addresses**.
2. Open the invitation for the entered owner email. Complete email verification, password setup and authenticator setup.
3. Use the same [Kinto login](https://localhost:3443/login) with the owner account and a fresh authenticator code. Access is granted only after the exact invited identity completes trusted MFA.
4. Open [organization](https://localhost:3443/organization), [employees](https://localhost:3443/employees) and [members](https://localhost:3443/members).

The **Forgot password** link is on Keycloak's login page. Its email appears in the same local inbox. Neither companies nor employees can self-register. Company owner/HR creates employee account invitations through Kinto.

This machine's setup verification also created **Local Demo Company**. Its owner credentials are in the ignored `.local/auth/demo-company.txt`; enroll your own authenticator at first login. It contains no real company or employee data. Password-reset links in the persistent local realm expire after 15 minutes; disposable provider expiry tests retain their 20-second window.

## Subsequent starts and stops

```bash
docker compose --env-file .env -f infra/compose.yaml -p kinto-hr up -d --wait
pnpm local:auth:up
pnpm local:dev
```

Keep the application terminal open. Ctrl+C stops this terminal's application processes and HTTPS proxy. If setup left it running in the background, `pnpm local:stop` validates its PID and project path before requesting shutdown; it refuses unrelated processes. To stop the identity provider and inbox without deleting data:

```bash
pnpm local:auth:stop
```

Database and Redis stopping remains the separate command in the root README. No blanket container cleanup, volume deletion or Redis flush is required.

`local:dev` refuses occupied application ports and waits for Keycloak discovery before starting the API, so a cold provider start does not cause an immediate authentication startup failure. Development incoming-request and browser-console forwarding are disabled to keep authorization callback query strings out of terminal logs.

## Private files and limitations

`.local/auth/` is ignored by Git. Its directory is private; generated credential/config/import/environment files and TLS private key are readable only by the local owner. Keycloak development database data persists there; Mailpit email persists in the dedicated Compose volume. The original `.env` snapshot is `.local/auth/env-before-auth`. Passwords changed in Keycloak do not update the initial credentials file. Repeat setup keeps the same realm, subjects and secrets and cannot reset an existing operator/password. Losing this private directory is not recoverable by silently creating a replacement operator.

The certificate lasts 90 days. To renew it, stop `local:dev`, remove only `.local/auth/key.pem` and `.local/auth/cert.pem`, repeat the setup command and restart. Do not delete credentials or provider database files.

Only localhost is supported: Kinto HTTPS `3443`, web `3000`, API `4000`, Keycloak `8080`, email UI `8025`, SMTP `1025`. Do not expose this configuration to a LAN or use live HR data. Production still needs reviewed HTTPS, provider PostgreSQL/backups, secret management, least-privilege policies, external mail delivery, MFA recovery, callback availability, abuse controls and security acceptance. This setup does not implement missing attendance/payroll features or enable production document storage.

Provider references: [Keycloak container and realm import documentation](https://www.keycloak.org/server/containers), [Mailpit Docker configuration](https://mailpit.axllent.org/docs/install/docker/).
