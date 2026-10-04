'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  attendanceAllocationSchema,
  attendanceAllocationSnapshotSchema,
  attendanceAllocationResultSchema,
  tenantIdSchema,
  type AttendanceAllocation,
} from '@kinto/contracts';

type Snapshot = ReturnType<typeof attendanceAllocationSnapshotSchema.parse>;
type Attempt = {
  tenantId: string;
  requestId: string;
  input: AttendanceAllocation;
};
type View =
  'loading' | 'ready' | 'signed-out' | 'select-company' | 'denied' | 'error';

export default function AllocationWorkspace({
  operatorTenant,
}: {
  operatorTenant?: string;
}) {
  const [view, setView] = useState<View>('loading');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [devices, setDevices] = useState('1');
  const [connectors, setConnectors] = useState('1');
  const [review, setReview] = useState<AttendanceAllocation | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  // Each route instance owns its in-memory request. Unmount cancels display updates.
  const alive = useRef(false);
  const operator = operatorTenant !== undefined;

  function clear(next: View) {
    setSnapshot(null);
    setReview(null);
    setPending(null);
    setEnabled(false);
    setDevices('1');
    setConnectors('1');
    setMessage('');
    setView(next);
  }
  function denied(status: number) {
    if (![401, 403, 404].includes(status)) return false;
    clear(status === 401 ? 'signed-out' : 'denied');
    return true;
  }
  // Never retain CSRF credentials: obtain a current session on every read/save/retry.
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
    if (denied(response.status)) return null;
    if (!response.ok) throw new Error('Session unavailable');
    const data: unknown = await response.json();
    if (!alive.current || signal?.aborted) return null;
    if (
      !data ||
      typeof data !== 'object' ||
      !('csrfToken' in data) ||
      typeof data.csrfToken !== 'string' ||
      !data.csrfToken
    )
      throw new Error('Invalid session');
    if (operator)
      return {
        tenantId: tenantIdSchema.parse(operatorTenant),
        csrf: data.csrfToken,
      };
    if (!('selectedTenantId' in data)) throw new Error('Invalid selection');
    if (data.selectedTenantId === null) {
      clear('select-company');
      return null;
    }
    const tenantId = tenantIdSchema.parse(data.selectedTenantId);
    if (!('tenants' in data) || !Array.isArray(data.tenants))
      throw new Error('Invalid company');
    const tenant = data.tenants.find(
      (item: unknown) =>
        item &&
        typeof item === 'object' &&
        'id' in item &&
        item.id === tenantId,
    );
    if (
      !tenant ||
      !Array.isArray(tenant.roles) ||
      !tenant.roles.some(
        (role: unknown) => role === 'owner' || role === 'hr_admin',
      )
    ) {
      clear('denied');
      return null;
    }
    return { tenantId, csrf: data.csrfToken };
  }
  function endpoint(tenantId: string) {
    return `/api/v1/${operator ? 'platform/' : ''}tenants/${tenantId}/attendance-entitlements`;
  }
  async function load(signal?: AbortSignal) {
    // Failed refresh must not leave old company data or a stale editable version.
    setSnapshot(null);
    setReview(null);
    setView('loading');
    const current = await session(signal);
    if (!current) return;
    const response = await fetch(endpoint(current.tenantId), {
      cache: 'no-store',
      signal,
    });
    if (!alive.current || signal?.aborted || denied(response.status)) return;
    if (!response.ok) throw new Error('Read unavailable');
    const parsed = attendanceAllocationSnapshotSchema.parse(
      await response.json(),
    );
    if (!alive.current || signal?.aborted) return;
    if (parsed.tenantId !== current.tenantId) throw new Error('Wrong company');
    setSnapshot(parsed);
    setEnabled(parsed.enabled);
    setDevices(String(parsed.deviceLimit || 1));
    setConnectors(String(parsed.connectorLimit || 1));
    setView('ready');
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (alive.current && !controller.signal.aborted) clear('error');
    });
    return () => {
      alive.current = false;
      controller.abort();
    };
    // The parent keys operator routes by tenant; company refresh resolves selection again.
  }, []);

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await load();
    } catch {
      if (alive.current) {
        setSnapshot(null);
        setView('error');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function preview(event: FormEvent) {
    event.preventDefault();
    if (!operator || !snapshot || pending || inFlight.current) return;
    const parsed = attendanceAllocationSchema.safeParse({
      expectedVersion: snapshot.version,
      enabled,
      deviceLimit: enabled ? Number(devices) : 0,
      connectorLimit: enabled ? Number(connectors) : 0,
      reason: enabled
        ? snapshot.version === 0
          ? 'initial_setup'
          : 'allocation_change'
        : 'disable_attendance',
    });
    if (!parsed.success) {
      setMessage('Use whole-number limits from 1 to 1000 when enabled.');
      return;
    }
    if (
      parsed.data.enabled === snapshot.enabled &&
      parsed.data.deviceLimit === snapshot.deviceLimit &&
      parsed.data.connectorLimit === snapshot.connectorLimit
    ) {
      setMessage('No allocation change to apply.');
      return;
    }
    setMessage('');
    setReview(parsed.data);
  }
  async function save(retry = false) {
    if (
      !operator ||
      inFlight.current ||
      (!retry && (pending || !review || !snapshot))
    )
      return;
    const attempt = retry
      ? pending
      : {
          tenantId: snapshot!.tenantId,
          requestId: crypto.randomUUID(),
          input: review!,
        };
    if (!attempt) return;
    inFlight.current = true;
    setBusy(true);
    setPending(attempt);
    setReview(null);
    setMessage('');
    let confirmed = false;
    try {
      const current = await session();
      if (!current || !alive.current) return;
      if (current.tenantId !== attempt.tenantId) {
        clear('denied');
        return;
      }
      const response = await fetch(endpoint(attempt.tenantId), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': current.csrf,
          'Idempotency-Key': attempt.requestId,
        },
        body: JSON.stringify(attempt.input),
      });
      if (!alive.current || denied(response.status)) return;
      if (response.status === 400 || response.status === 409) {
        setPending(null);
        setSnapshot(null);
        setView('error');
        setMessage(
          'Change refused or stale. Refresh allocation, review the current version and create a new request.',
        );
        return;
      }
      if (!response.ok) throw new Error('Uncertain');
      const receipt = attendanceAllocationResultSchema.parse(
        await response.json(),
      );
      if (receipt.version !== attempt.input.expectedVersion + 1)
        throw new Error('Invalid receipt');
      if (!alive.current) return;
      confirmed = true;
      setPending(null);
      await load();
      if (alive.current)
        setMessage(
          'Allocation receipt confirmed. The refreshed version shows current state; a retry does not restore an older allocation.',
        );
    } catch {
      if (!alive.current) return;
      setSnapshot(null);
      setView('error');
      setMessage(
        confirmed
          ? 'Allocation receipt confirmed, but current state could not be loaded. Refresh before making another change.'
          : 'Outcome could not be confirmed. Retry the exact retained request. Keep this page open: reloading loses its request ID. Refresh does not resolve an uncertain save.',
      );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ATTENDANCE CAPACITY</p>
          <h1>
            {operator
              ? 'Manage attendance allocation'
              : 'Company attendance allocation'}
          </h1>
          <p className="subtitle">
            Capacity allocation does not connect devices or grant machine
            access.
          </p>
        </div>
      </div>
      <section className="settings-card">
        <p className="notice">
          Machine access is unavailable. Connector enrollment, actual usage
          enforcement and K50 hardware validation are not implemented.
        </p>
        {view !== 'ready' && (
          <p role="status">
            {
              {
                loading: 'Loading attendance allocation…',
                ready: '',
                'signed-out': 'Sign in to review attendance allocation.',
                'select-company': 'Choose a company workspace first.',
                denied:
                  'Recent verification and authorized access to an active company are required.',
                error: 'Attendance allocation is unavailable.',
              }[view]
            }
          </p>
        )}
        {snapshot && (
          <div aria-label="Current attendance allocation">
            <p>Company: {snapshot.tenantId}</p>
            <p>Allocation version: {snapshot.version}</p>
            <p>
              Attendance allocation: {snapshot.enabled ? 'Enabled' : 'Disabled'}
            </p>
            <p>
              Device limit: {snapshot.deviceLimit} · Connector limit:{' '}
              {snapshot.connectorLimit}
            </p>
            <p>Configured: {snapshot.configuredAt ?? 'Not configured'}</p>
          </div>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh attendance allocation
        </button>
        {message && <p role="status">{message}</p>}
        {pending && (
          <div className="notice">
            <p>
              Unconfirmed request: {pending.requestId}. Expected version{' '}
              {pending.input.expectedVersion}.{' '}
              {pending.input.enabled
                ? `Enable with ${pending.input.deviceLimit} devices and ${pending.input.connectorLimit} connectors.`
                : 'Disable with zero limits.'}
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Retry exact allocation request
            </button>
          </div>
        )}
        {!operator && (
          <p>
            Only platform operators can change these limits. Owners and HR have
            read-only access.
          </p>
        )}
        {(view === 'signed-out' || view === 'select-company') && (
          <Link href="/login">Open account access →</Link>
        )}
      </section>
      {operator && snapshot && (
        <section className="settings-card allocation-controls">
          <h2>Change allocation</h2>
          <form className="settings-form" onSubmit={preview}>
            <fieldset
              className="allocation-fields"
              disabled={busy || pending !== null}
            >
              <legend>Allocation details</legend>
              <label className="allocation-toggle">
                Attendance enabled
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => {
                    setEnabled(event.target.checked);
                    setReview(null);
                  }}
                />
              </label>
              <label>
                Device limit
                <input
                  type="number"
                  required={enabled}
                  disabled={!enabled}
                  min={1}
                  max={1000}
                  step={1}
                  value={devices}
                  onChange={(event) => {
                    setDevices(event.target.value);
                    setReview(null);
                  }}
                />
              </label>
              <label>
                Connector limit
                <input
                  type="number"
                  required={enabled}
                  disabled={!enabled}
                  min={1}
                  max={1000}
                  step={1}
                  value={connectors}
                  onChange={(event) => {
                    setConnectors(event.target.value);
                    setReview(null);
                  }}
                />
              </label>
              <button type="submit" className="primary-button">
                Review allocation change
              </button>
            </fieldset>
          </form>
          {review && (
            <div className="notice">
              <p>
                Review version {review.expectedVersion} →{' '}
                {review.expectedVersion + 1}:{' '}
                {review.enabled
                  ? `enable ${review.deviceLimit} devices and ${review.connectorLimit} connectors`
                  : 'disable attendance allocation with zero limits'}
                . Reason: {review.reason.replaceAll('_', ' ')}. Existing history
                remains preserved.
              </p>
              <button
                type="button"
                className="primary-button"
                disabled={busy || pending !== null}
                onClick={() => void save()}
              >
                Confirm allocation change
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
