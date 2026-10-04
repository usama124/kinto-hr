'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  attendanceAllocationSnapshotSchema,
  deviceInventorySchema,
  enrollmentListSchema,
  enrollmentIssueSchema,
  enrollmentIssueResultSchema,
  enrollmentItemSchema,
  connectorListSchema,
  connectorRecordSchema,
  tenantIdSchema,
  type EnrollmentIssue,
} from '@kinto/contracts';

type View =
  | 'loading'
  | 'ready'
  | 'signed-out'
  | 'select-company'
  | 'denied'
  | 'disabled'
  | 'error';
type Cursors = {
  devices: string | null;
  tokens: string | null;
  credentials: string | null;
};
type Snapshot = {
  tenantId: string;
  identityId: string;
  company: string;
  owner: boolean;
  devices: ReturnType<typeof deviceInventorySchema.parse>;
  tokens: ReturnType<typeof enrollmentListSchema.parse>;
  credentials: ReturnType<typeof connectorListSchema.parse>;
  allocation: ReturnType<typeof attendanceAllocationSnapshotSchema.parse>;
};
type Attempt =
  | {
      tenantId: string;
      identityId: string;
      kind: 'issue';
      key: string;
      input: EnrollmentIssue;
    }
  | {
      tenantId: string;
      identityId: string;
      kind: 'token' | 'credential';
      id: string;
    };
const first: Cursors = { devices: null, tokens: null, credentials: null };
function pageValid(
  data: { items: { id: string }[]; nextCursor: string | null },
  cursor: string | null,
) {
  if (
    data.items.length > 25 ||
    data.items.some(
      (item, index) =>
        (cursor !== null && item.id <= cursor) ||
        (index > 0 && item.id <= data.items[index - 1].id),
    ) ||
    (data.nextCursor !== null &&
      (data.items.length !== 25 || data.nextCursor !== data.items.at(-1)?.id))
  )
    throw new Error('Invalid page');
}
export default function Connectors() {
  const [view, setView] = useState<View>('loading');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [cursors, setCursors] = useState<Cursors>(first);
  const [device, setDevice] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null);
  const [secret, setSecret] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false),
    alive = useRef(false),
    pendingRef = useRef<Attempt | null>(null);
  function retain(attempt: Attempt | null) {
    pendingRef.current = attempt;
    setPending(attempt);
  }
  function clear(next: View) {
    setSnapshot(null);
    setSecret(null);
    retain(null);
    setDevice('');
    setCursors(first);
    setNeedsRefresh(false);
    setMessage('');
    setView(next);
  }
  function access(status: number, local = false) {
    if (![401, 403, 404].includes(status)) return false;
    clear(
      status === 401
        ? 'signed-out'
        : status === 404 && local
          ? 'disabled'
          : 'denied',
    );
    return true;
  }
  async function session(signal?: AbortSignal) {
    const response = await fetch('/api/v1/auth/session', {
      cache: 'no-store',
      signal,
    });
    if (!alive.current || signal?.aborted) return null;
    if (response.status === 401 || response.status === 404) {
      clear('signed-out');
      return null;
    }
    if (access(response.status)) return null;
    if (!response.ok) throw new Error('Session unavailable');
    const data: unknown = await response.json();
    if (!alive.current || signal?.aborted) return null;
    if (!data || typeof data !== 'object' || !('selectedTenantId' in data))
      throw new Error('Invalid session');
    if (data.selectedTenantId === null) {
      clear('select-company');
      return null;
    }
    const tenantId = tenantIdSchema.parse(data.selectedTenantId);
    if (!('identityId' in data)) throw new Error('Invalid identity');
    const identityId = tenantIdSchema.parse(data.identityId);
    if (
      !('csrfToken' in data) ||
      typeof data.csrfToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken) ||
      !('tenants' in data) ||
      !Array.isArray(data.tenants)
    )
      throw new Error('Invalid session');
    const tenant = data.tenants.find(
      (item: unknown) =>
        item &&
        typeof item === 'object' &&
        'id' in item &&
        item.id === tenantId,
    );
    if (
      !tenant ||
      typeof tenant.name !== 'string' ||
      !tenant.name ||
      !Array.isArray(tenant.roles)
    )
      throw new Error('Invalid company');
    const owner = tenant.roles.includes('owner');
    if (!owner && !tenant.roles.includes('hr_admin')) {
      clear('denied');
      return null;
    }
    return {
      tenantId,
      identityId,
      company: tenant.name as string,
      owner,
      csrf: data.csrfToken,
    };
  }
  const endpoint = (tenant: string) =>
    `/api/v1/tenants/${tenant}/local-connectors`;
  async function load(next: Cursors, signal?: AbortSignal) {
    setSecret(null);
    setSnapshot(null);
    setDevice('');
    setView('loading');
    const current = await session(signal);
    if (!current) return;
    if (
      pendingRef.current &&
      (pendingRef.current.tenantId !== current.tenantId ||
        pendingRef.current.identityId !== current.identityId ||
        !current.owner)
    )
      retain(null);
    const query = (cursor: string | null) =>
      `?limit=25${cursor ? '&afterId=' + encodeURIComponent(cursor) : ''}`;
    const responses = await Promise.all([
      fetch(
        `/api/v1/tenants/${current.tenantId}/devices${query(next.devices)}`,
        { cache: 'no-store', signal },
      ),
      fetch(
        endpoint(current.tenantId) + '/enrollment-tokens' + query(next.tokens),
        { cache: 'no-store', signal },
      ),
      fetch(
        endpoint(current.tenantId) + '/credentials' + query(next.credentials),
        { cache: 'no-store', signal },
      ),
      fetch(`/api/v1/tenants/${current.tenantId}/attendance-entitlements`, {
        cache: 'no-store',
        signal,
      }),
    ]);
    if (!alive.current || signal?.aborted) return;
    // Access denial wins over disabled/not-found signals in a mixed response set.
    for (const status of [401, 403])
      if (responses.some((r) => r.status === status)) {
        access(status);
        return;
      }
    if (responses[1].status === 404 || responses[2].status === 404) {
      clear('disabled');
      return;
    }
    if (responses.some((r) => !r.ok)) throw new Error('Read unavailable');
    const values = await Promise.all(responses.map((r) => r.json()));
    const devices = deviceInventorySchema.parse(values[0]),
      tokens = enrollmentListSchema.parse(values[1]),
      credentials = connectorListSchema.parse(values[2]),
      allocation = attendanceAllocationSnapshotSchema.parse(values[3]);
    pageValid(devices, next.devices);
    pageValid(tokens, next.tokens);
    pageValid(credentials, next.credentials);
    if (
      allocation.tenantId !== current.tenantId ||
      credentials.items.some((item) => item.tenantId !== current.tenantId)
    )
      throw new Error('Wrong company');
    if (!alive.current || signal?.aborted) return;
    setSnapshot({
      tenantId: current.tenantId,
      identityId: current.identityId,
      company: current.company,
      owner: current.owner,
      devices,
      tokens,
      credentials,
      allocation,
    });
    setCursors(next);
    setNeedsRefresh(false);
    setView('ready');
  }
  useEffect(() => {
    alive.current = true;
    inFlight.current = true;
    setBusy(true);
    const controller = new AbortController();
    void load(first, controller.signal)
      .catch(() => {
        if (alive.current && !controller.signal.aborted) clear('error');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          inFlight.current = false;
          if (alive.current) setBusy(false);
        }
      });
    const erase = () => {
      if (secretInput.current) {
        secretInput.current.value = '';
        secretInput.current.defaultValue = '';
      }
      setSecret(null);
    };
    const hide = () => {
      if (document.hidden) erase();
    };
    window.addEventListener('pagehide', erase);
    window.addEventListener('pageshow', erase);
    document.addEventListener('visibilitychange', hide);
    return () => {
      alive.current = false;
      controller.abort();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', erase);
      window.removeEventListener('pageshow', erase);
    };
  }, []);
  useEffect(() => {
    if (!secret) return;
    const remaining = Date.parse(secret.expiresAt) - Date.now();
    if (remaining <= 0) {
      setSecret(null);
      return;
    }
    const timer = setTimeout(() => setSecret(null), remaining);
    return () => clearTimeout(timer);
  }, [secret]);
  async function refresh(next: Cursors = first) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      await load(next);
    } catch {
      if (alive.current) {
        setSecret(null);
        setSnapshot(null);
        setView('error');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function command(attempt: Attempt, retry = false) {
    if (inFlight.current || (!retry && (pendingRef.current || needsRefresh)))
      return;
    inFlight.current = true;
    setBusy(true);
    setSecret(null);
    setMessage('');
    retain(attempt);
    try {
      const current = await session();
      if (!current) return;
      if (
        current.tenantId !== attempt.tenantId ||
        current.identityId !== attempt.identityId ||
        !current.owner
      ) {
        clear('denied');
        return;
      }
      const url =
        attempt.kind === 'issue'
          ? endpoint(attempt.tenantId) + '/enrollment-tokens'
          : endpoint(attempt.tenantId) +
            `/${attempt.kind === 'token' ? 'enrollment-tokens' : 'credentials'}/${attempt.id}/revocation`;
      const response = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': current.csrf,
          ...(attempt.kind === 'issue'
            ? { 'Idempotency-Key': attempt.key }
            : {}),
        },
        body: JSON.stringify(
          attempt.kind === 'issue' ? attempt.input : { expectedVersion: 1 },
        ),
      });
      if (!alive.current) return;
      if (access(response.status, true)) return;
      if ([400, 409].includes(response.status)) {
        retain(null);
        setNeedsRefresh(true);
        setMessage(
          'Command rejected. Refresh current versions and capacity before making another change.',
        );
        return;
      }
      if (!response.ok) throw new Error('Uncertain');
      const raw: unknown = await response.json();
      if (!alive.current) return;
      if (attempt.kind === 'issue') {
        const result = enrollmentIssueResultSchema.parse(raw),
          row = result.enrollment;
        if (
          row.deviceId !== attempt.input.deviceId ||
          row.expectedDeviceVersion !== attempt.input.expectedDeviceVersion ||
          row.allocationVersion !== attempt.input.expectedAllocationVersion ||
          (retry && !result.replayed)
        )
          throw new Error('Invalid receipt');
        if (
          result.token &&
          Date.parse(row.expiresAt) > Date.now() &&
          !document.hidden
        )
          setSecret({ token: result.token, expiresAt: row.expiresAt });
        setMessage(
          result.replayed
            ? 'Request reconciled. The original token cannot be recovered; inspect metadata, revoke it or its redeemed credential, then issue a new token.'
            : 'Token issued once. Transfer it to the authorized local test client before hiding or refreshing this page.',
        );
      } else {
        const row =
          attempt.kind === 'token'
            ? enrollmentItemSchema.parse(raw)
            : connectorRecordSchema.parse(raw);
        if (
          row.id !== attempt.id ||
          row.status !== 'revoked' ||
          (attempt.kind === 'credential' &&
            'tenantId' in row &&
            row.tenantId !== attempt.tenantId)
        )
          throw new Error('Invalid receipt');
        setMessage(
          'Revocation confirmed. Refresh metadata before another change.',
        );
      }
      retain(null);
      setNeedsRefresh(true);
    } catch {
      if (alive.current) {
        setSecret(null);
        setSnapshot(null);
        setView('error');
        setNeedsRefresh(true);
        setMessage(
          'Outcome unknown. New changes are locked. Refresh metadata or retry this exact command; no secret can be recovered after a lost response.',
        );
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function issue(event: FormEvent) {
    event.preventDefault();
    if (
      !snapshot?.owner ||
      !snapshot.allocation.enabled ||
      inFlight.current ||
      pending ||
      needsRefresh ||
      occupied.has(device)
    )
      return;
    const selected = snapshot.devices.items.find(
      (item) => item.id === device && item.status === 'draft',
    );
    if (!selected) return;
    const parsed = enrollmentIssueSchema.safeParse({
      deviceId: selected.id,
      expectedDeviceVersion: selected.version,
      expectedAllocationVersion: snapshot.allocation.version,
    });
    if (!parsed.success) {
      setNeedsRefresh(true);
      setMessage(
        'Selected versions cannot be used. Refresh metadata before issuing a token.',
      );
      return;
    }
    void command({
      tenantId: snapshot.tenantId,
      identityId: snapshot.identityId,
      kind: 'issue',
      key: crypto.randomUUID(),
      input: parsed.data,
    });
  }
  function revoke(kind: 'token' | 'credential', id: string) {
    if (
      !snapshot?.owner ||
      busy ||
      needsRefresh ||
      pending ||
      !window.confirm(
        `Revoke this ${kind === 'token' ? 'enrollment token' : 'connector credential'}? Access will not be restored by retrying an older command.`,
      )
    )
      return;
    void command({
      tenantId: snapshot.tenantId,
      identityId: snapshot.identityId,
      kind,
      id,
    });
  }
  const locked = busy || needsRefresh || pending !== null;
  const occupied = new Set([
    ...(snapshot?.tokens.items
      .filter((item) => item.status === 'issued')
      .map((item) => item.deviceId) ?? []),
    ...(snapshot?.credentials.items
      .filter((item) => item.status === 'active')
      .map((item) => item.deviceId) ?? []),
  ]);
  const eligible =
    snapshot?.devices.items.filter(
      (item) => item.status === 'draft' && !occupied.has(item.id),
    ) ?? [];
  function pagination(kind: keyof Cursors, next: string | null) {
    return (
      <div className="device-controls">
        <button
          className="secondary-button"
          disabled={busy || cursors[kind] === null}
          onClick={() => void refresh({ ...cursors, [kind]: null })}
        >
          First {kind} page
        </button>
        <button
          className="secondary-button"
          disabled={busy || next === null}
          onClick={() => next && void refresh({ ...cursors, [kind]: next })}
        >
          Next {kind} page
        </button>
      </div>
    );
  }
  return (
    <>
      <section className="page-header">
        <p className="eyebrow">PHASE 2 · LOCAL TEST ONLY</p>
        <h1>Connector enrollment</h1>
        <p>
          Enrollment tokens and revocable heartbeat-only credentials. No K50
          connection, attendance upload or production machine access is enabled
          by this screen.
        </p>
        <Link href="/devices">Draft devices</Link> ·{' '}
        <Link href="/attendance-capacity">Attendance capacity</Link>
      </section>
      <section
        className="settings-card device-workspace"
        aria-label="Connector status"
      >
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh connector metadata
        </button>
        {view === 'loading' && <p>Loading current company and metadata…</p>}
        {view === 'signed-out' && <p>Sign in to view connectors.</p>}
        {view === 'select-company' && (
          <p>Select a company before viewing connectors.</p>
        )}
        {view === 'denied' && (
          <p>
            Connector access is unavailable for this session. Company data and
            secrets have been cleared.
          </p>
        )}
        {view === 'disabled' && (
          <p>
            Local connector HTTP mode is disabled. An operator must configure
            the synthetic local-test mode; production mode is not available.
          </p>
        )}
        {view === 'error' && (
          <p>Connector metadata could not be verified. Refresh to retry.</p>
        )}
        {message && <p role="status">{message}</p>}
        {pending && (
          <div>
            <p>
              One exact command is awaiting reconciliation. No new commands are
              permitted, even after refresh.
            </p>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void command(pending, true)}
            >
              Retry exact command
            </button>
          </div>
        )}
        {secret && (
          <section
            className="connector-secret"
            aria-label="One-time enrollment secret"
          >
            <h2>One-time enrollment token</h2>
            <p>
              Expires {new Date(secret.expiresAt).toLocaleString()}. This value
              is not saved in browser storage. Hiding the page, refreshing or
              expiry clears it. A hidden token cannot be recovered.
            </p>
            <label>
              Enrollment token
              <input
                ref={secretInput}
                readOnly
                autoComplete="off"
                spellCheck={false}
                value={secret.token}
              />
            </label>
            <button
              className="secondary-button"
              onClick={() => setSecret(null)}
            >
              Hide enrollment token
            </button>
          </section>
        )}
      </section>
      {view === 'ready' && snapshot && (
        <>
          <section className="settings-card device-workspace">
            <h2>{snapshot.company}</h2>
            <p>
              {snapshot.owner ? 'Owner access' : 'HR read-only access'} ·
              synthetic heartbeat-only workflow.
            </p>
            <p>
              Configured limits: {snapshot.allocation.deviceLimit} devices /{' '}
              {snapshot.allocation.connectorLimit} connectors. These are limits,
              not live usage totals. Reservations and credentials consume
              capacity until expiry or revocation.
            </p>
            {!snapshot.allocation.enabled && (
              <p>
                Attendance allocation is disabled. The platform operator must
                enable capacity before enrollment.
              </p>
            )}
            {needsRefresh && (
              <p>
                Refresh metadata before another change. Refresh also hides any
                displayed token.
              </p>
            )}
            {snapshot.owner && (
              <form className="device-form" onSubmit={issue}>
                <fieldset
                  disabled={
                    locked ||
                    !snapshot.allocation.enabled ||
                    eligible.length === 0
                  }
                >
                  <label>
                    Draft device
                    <select
                      required
                      value={device}
                      onChange={(event) => setDevice(event.target.value)}
                    >
                      <option value="">Choose a draft device</option>
                      {eligible.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} · {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    Owner changes require recent MFA. Creates one 15-minute
                    token for the selected device and current allocation
                    versions. It reserves one device and connector slot. Earlier
                    preparatory tokens cannot be redeemed by the local HTTP
                    client.
                  </p>
                  <button className="primary-button" type="submit">
                    Issue enrollment token
                  </button>
                </fieldset>
              </form>
            )}
            {eligible.length === 0 && (
              <p>
                No eligible draft device on this page. Inspect
                reservations/credentials, browse draft devices or register a new
                draft.
              </p>
            )}
            {pagination('devices', snapshot.devices.nextCursor)}
          </section>
          <section
            className="settings-card device-workspace"
            aria-label="Enrollment history"
          >
            <h2>Enrollment history</h2>
            {snapshot.tokens.items.length === 0 && (
              <p>No enrollment tokens on this page.</p>
            )}
            {snapshot.tokens.items.map((item) => (
              <article className="connector-record" key={item.id}>
                <h3>Enrollment {item.id}</h3>
                <p>
                  Device {item.deviceId} · {item.status} · expires{' '}
                  {new Date(item.expiresAt).toLocaleString()}
                </p>
                {item.connectorId && (
                  <p>
                    Redeemed credential: {item.connectorId}. Revoke that
                    credential to remove access.
                  </p>
                )}
                {snapshot.owner &&
                  ['issued', 'expired'].includes(item.status) && (
                    <button
                      className="secondary-button"
                      disabled={locked}
                      onClick={() => revoke('token', item.id)}
                    >
                      Revoke enrollment {item.id}
                    </button>
                  )}
              </article>
            ))}
            {pagination('tokens', snapshot.tokens.nextCursor)}
          </section>
          <section
            className="settings-card device-workspace"
            aria-label="Connector credentials"
          >
            <h2>Connector credentials</h2>
            <p>
              Credential secrets are never listed or recoverable here. Active
              metadata does not override an external admission revocation after
              a database restore. For a lost redemption response, revoke the
              credential and issue a new token.
            </p>
            {snapshot.credentials.items.length === 0 && (
              <p>No credentials on this page.</p>
            )}
            {snapshot.credentials.items.map((item) => (
              <article className="connector-record" key={item.id}>
                <h3>Credential {item.id}</h3>
                <p>
                  Device {item.deviceId} · {item.status} · heartbeat only ·
                  expires {new Date(item.expiresAt).toLocaleString()}
                </p>
                {snapshot.owner && item.status !== 'revoked' && (
                  <button
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => revoke('credential', item.id)}
                  >
                    Revoke credential {item.id}
                  </button>
                )}
              </article>
            ))}
            {pagination('credentials', snapshot.credentials.nextCursor)}
          </section>
        </>
      )}
    </>
  );
}
