# Synthetic local connector lifecycle client

Date: 4 October 2026. Scope: P02-02 preparation, not hardware or production acceptance.

## Implementation

`scripts/lib/local-connector-client.ts` is a TypeScript reference client for the existing gated local-test API. This deliberately does not select the K50 SDK/runtime or introduce an installer, background service, durable queue or plaintext credential file.

Construct with `mode: local_test`, a literal `http://127.0.0.1:<port>` origin and the expected tenant, device and enrollment UUIDs. Production mode is rejected. Call `redeem(token)` once; call `heartbeat()` explicitly while active; call `stop()` on shutdown. No command-line token input, environment secret, automatic enrollment, retry scheduler or browser integration is introduced.

Enrollment replies must match the expected binding and an active, unexpired heartbeat-only credential. Credentials remain private in process memory. The public projection returns a copy of safe metadata. Process restart loses authorization: HR must inspect/revoke the previous credential and issue a new token rather than recover secrets from SQL. Memory storage here is a synthetic restriction, not OS-protected storage or guaranteed physical memory zeroization.

Redemption failures become terminal `uncertain` state, including timeout, lost response, malformed reply and redirect. Never resend automatically: the server may already have consumed the token. HR reconciles using the existing credential workspace. Heartbeat transport/server failures permit a later explicit heartbeat retry. Authorization denial (401/403), disabled route (404), local expiry or parsed identity mismatch clears authorization. Stop aborts in-flight requests and prevents late credential adoption.

Requests use direct Node HTTP sockets, no DNS/proxy configuration or redirect following, no cookie/origin/forwarded headers, a total request deadline, no more than one in-flight operation and a 16 KiB response limit. Responses and transport errors are never included in public error messages. No attendance records or biometric data are read or uploaded.

## Verification

- 25 focused tests use actual synthetic loopback HTTP sockets: successful enrollment/heartbeat, safe metadata, destination/config restrictions, invalid token, lost response, deadline, redirects, oversized/malformed replies, binding mismatch, concurrent heartbeat, explicit retry after outage, denial, expiry and shutdown.
- Existing API lifecycle integration extended to exercise this client against real Nest HTTP, synthetic PostgreSQL and isolated Redis admission state, including owner revocation.
- `pnpm verify` passed: formatting, lint, root/web type checks, 264 unit/API tests, coverage thresholds, documentation links and readiness manifest. Production readiness remains unaccepted.
- All 229 integration tests passed, including the extended lifecycle scenario. This document does not claim hardware validation.

Builds, browser tests, migrations and recovery drills were not rerun for this script-only increment; no UI, server endpoint or database schema changed.

## Remaining gates

Host OS and K50 SDK evidence must determine the actual connector runtime and OS-protected secret store. Durable backlog, device polling, proven source-event identity, credential rotation, production admission lifecycle, installer integrity and service restart support remain pending. No production connector endpoint is enabled by this increment.
