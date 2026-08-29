import Link from 'next/link';
import { ConnectionStatus } from '../connection-status';
export default function Setup() {
  return (
    <>
      <p className="eyebrow">LOCAL ENVIRONMENT</p>
      <h1>Connect the foundation.</h1>
      <p className="subtitle">
        Run the API and isolated PostgreSQL database alongside this workspace.
      </p>
      <ConnectionStatus />
      <section className="guide">
        <h2>Before you connect</h2>
        <ol>
          <li>
            <strong>Prepare your environment.</strong>
            <p>
              Use the pinned Node.js and pnpm versions in the repository. Copy
              the example environment file for local development only.
            </p>
          </li>
          <li>
            <strong>Start the database.</strong>
            <p>
              Follow the root README to start the isolated database, apply
              migrations and provision the restricted application role.
            </p>
          </li>
          <li>
            <strong>Run the development services.</strong>
            <p>
              Start the API and web application with the documented development
              command, then check the connection above.
            </p>
          </li>
        </ol>
      </section>
      <div className="notice">
        <strong>Access is intentionally closed.</strong>
        <p>
          The OIDC session adapter and an explicit Keycloak LoA 2 profile are
          available for configured test environments; sign-in is disabled by
          default. Account provisioning and complete reset-session revocation
          are still pending. There is no demo login, default administrator or
          development token that opens employee data.
        </p>
      </div>
      <Link className="text-link" href="/">
        ← Back to overview
      </Link>
    </>
  );
}
