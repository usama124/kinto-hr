'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  deviceInventorySchema,
  tenantIdSchema,
  syntheticInboxReviewListSchema,
  syntheticInboxPreviewQuerySchema,
  syntheticInboxMappingPreviewSchema,
} from '@kinto/contracts';

type View =
  'loading' | 'ready' | 'signed-out' | 'select-company' | 'denied' | 'error';
type Scope = { tenantId: string; identityId: string; company: string };
type Snapshot = Scope & {
  devices: ReturnType<typeof deviceInventorySchema.parse>;
  inbox: ReturnType<typeof syntheticInboxReviewListSchema.parse> | null;
};
type Position = {
  devices: string | null;
  events: string | null;
  deviceId: string | null;
};
const first: Position = { devices: null, events: null, deviceId: null };
const base = (tenant: string, device: string) =>
  `/api/v1/tenants/${tenant}/local-connectors/devices/${device}/synthetic-inbox`;
function pageValid(
  page: { items: { id: string }[]; nextCursor: string | null },
  after: string | null,
) {
  if (
    page.items.length > 25 ||
    page.items.some(
      (item, index) =>
        (after !== null && item.id <= after) ||
        (index > 0 && item.id <= page.items[index - 1].id),
    ) ||
    (page.nextCursor !== null &&
      (page.items.length !== 25 || page.nextCursor !== page.items.at(-1)?.id))
  )
    throw new Error('Invalid page');
}
const same = (a: Scope, b: Scope) =>
  a.tenantId === b.tenantId && a.identityId === b.identityId;
export default function AttendanceReview() {
  const [view, setView] = useState<View>('loading');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [position, setPosition] = useState(first);
  const [busy, setBusy] = useState(false);
  const [eventId, setEventId] = useState('');
  const [at, setAt] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<ReturnType<
    typeof syntheticInboxMappingPreviewSchema.parse
  > | null>(null);
  const alive = useRef(false),
    flight = useRef(false);
  function resetPreview() {
    setEventId('');
    setAt('');
    setPreview(null);
    setMessage('');
  }
  function clear(next: View) {
    setSnapshot(null);
    setPosition(first);
    resetPreview();
    setView(next);
  }
  function access(status: number) {
    if (![401, 403, 404].includes(status)) return false;
    clear(status === 401 ? 'signed-out' : 'denied');
    return true;
  }
  async function session(signal?: AbortSignal): Promise<Scope | null> {
    const response = await fetch('/api/v1/auth/session', {
      cache: 'no-store',
      signal,
    });
    if (!alive.current || signal?.aborted) return null;
    if (response.status === 404) {
      clear('signed-out');
      return null;
    }
    if (access(response.status)) return null;
    if (!response.ok) throw new Error('Session unavailable');
    const raw: unknown = await response.json();
    if (!alive.current || signal?.aborted) return null;
    if (!raw || typeof raw !== 'object' || !('selectedTenantId' in raw))
      throw new Error('Invalid session');
    if (raw.selectedTenantId === null) {
      clear('select-company');
      return null;
    }
    const tenantId = tenantIdSchema.parse(raw.selectedTenantId);
    if (
      !('identityId' in raw) ||
      !('tenants' in raw) ||
      !Array.isArray(raw.tenants)
    )
      throw new Error('Invalid session');
    const identityId = tenantIdSchema.parse(raw.identityId);
    const companies = raw.tenants.filter(
      (v: unknown) =>
        v && typeof v === 'object' && 'id' in v && v.id === tenantId,
    );
    const company = companies[0];
    if (
      companies.length !== 1 ||
      typeof company.name !== 'string' ||
      !company.name ||
      !Array.isArray(company.roles)
    )
      throw new Error('Invalid company');
    if (
      !company.roles.includes('owner') &&
      !company.roles.includes('hr_admin')
    ) {
      clear('denied');
      return null;
    }
    return { tenantId, identityId, company: company.name };
  }
  async function confirm(scope: Scope, signal?: AbortSignal) {
    const current = await session(signal);
    if (!current) return false;
    if (!same(scope, current)) {
      clear('denied');
      return false;
    }
    return true;
  }
  async function load(next: Position, signal?: AbortSignal) {
    const previous = snapshot;
    setSnapshot(null);
    resetPreview();
    setView('loading');
    const current = await session(signal);
    if (!current) return;
    if (previous && !same(previous, current)) next = first;
    const response = await fetch(
      `/api/v1/tenants/${current.tenantId}/devices?limit=25${next.devices ? '&afterId=' + next.devices : ''}`,
      { cache: 'no-store', signal },
    );
    if (!alive.current || signal?.aborted) return;
    if (access(response.status)) return;
    if (!response.ok) throw new Error('Devices unavailable');
    const devices = deviceInventorySchema.parse(await response.json());
    pageValid(devices, next.devices);
    const chosen =
      devices.items.find((v) => v.id === next.deviceId) ?? devices.items[0];
    let inbox: Snapshot['inbox'] = null;
    if (chosen) {
      const cursor = chosen.id === next.deviceId ? next.events : null;
      const result = await fetch(
        base(current.tenantId, chosen.id) +
          `?limit=25${cursor ? '&afterId=' + cursor : ''}`,
        { cache: 'no-store', signal },
      );
      if (!alive.current || signal?.aborted) return;
      if (access(result.status)) return;
      if (!result.ok) throw new Error('Inbox unavailable');
      inbox = syntheticInboxReviewListSchema.parse(await result.json());
      if (
        inbox.tenantId !== current.tenantId ||
        inbox.deviceId !== chosen.id ||
        inbox.items.some((v) => v.deviceId !== chosen.id)
      )
        throw new Error('Wrong scope');
      pageValid(inbox, cursor);
      next = { ...next, deviceId: chosen.id, events: cursor };
    } else next = { ...next, deviceId: null, events: null };
    if (!(await confirm(current, signal)) || !alive.current || signal?.aborted)
      return;
    setSnapshot({ ...current, devices, inbox });
    setPosition(next);
    setView('ready');
  }
  useEffect(() => {
    alive.current = true;
    flight.current = true;
    setBusy(true);
    const controller = new AbortController();
    void load(first, controller.signal)
      .catch(() => {
        if (alive.current && !controller.signal.aborted) clear('error');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          flight.current = false;
          if (alive.current) setBusy(false);
        }
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);
  async function refresh(next: Position = first) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await load(next);
    } catch {
      if (alive.current) clear('error');
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function resolve(event: FormEvent) {
    event.preventDefault();
    const selected = snapshot?.inbox?.items.find((v) => v.id === eventId);
    if (!snapshot || !selected || flight.current) return;
    setPreview(null);
    setMessage('');
    const input = syntheticInboxPreviewQuerySchema.safeParse({ at });
    if (!input.success) {
      setMessage('Enter a valid timestamp with UTC Z or an explicit offset.');
      return;
    }
    flight.current = true;
    setBusy(true);
    try {
      if (!(await confirm(snapshot))) return;
      const response = await fetch(
        base(snapshot.tenantId, selected.deviceId) +
          '/' +
          selected.id +
          '/mapping-preview?' +
          new URLSearchParams(input.data),
        { cache: 'no-store' },
      );
      if (!alive.current) return;
      if (access(response.status)) return;
      if (!response.ok) throw new Error('Preview unavailable');
      const result = syntheticInboxMappingPreviewSchema.parse(
        await response.json(),
      );
      if (
        result.requestedAt !== input.data.at ||
        JSON.stringify(result.event) !== JSON.stringify(selected)
      )
        throw new Error('Wrong preview');
      if (!(await confirm(snapshot)) || !alive.current) return;
      setPreview(result);
    } catch {
      if (alive.current) clear('error');
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const chosen = snapshot?.devices.items.find(
    (v) => v.id === position.deviceId,
  );
  return (
    <>
      <section className="page-header">
        <p className="eyebrow">PHASE 2 · SYNTHETIC REVIEW ONLY</p>
        <h1>Attendance inbox review</h1>
        <p>
          Read-only quarantined fixtures. No live K50 upload, attendance
          calculation, leave deduction or payroll effect.
        </p>
        <Link href="/device-mappings">Device employee mappings</Link>
      </section>
      <section
        className="settings-card device-workspace"
        aria-label="Inbox status"
      >
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh inbox review
        </button>
        {view === 'loading' && (
          <p>Loading current company and quarantined records…</p>
        )}
        {view === 'signed-out' && (
          <p>Sign in to review the synthetic attendance inbox.</p>
        )}
        {view === 'select-company' && (
          <p>
            Select a company before reviewing the inbox.{' '}
            <Link href="/login">Account access</Link>
          </p>
        )}
        {view === 'denied' && (
          <p>
            Review is disabled, access denied or context changed. Use an
            authorized owner/HR session with recent MFA and the local-test
            connector gate.
          </p>
        )}
        {view === 'error' && (
          <p>
            Inbox data is unavailable or invalid. Refresh to load current
            records.
          </p>
        )}
        {snapshot && <p>{snapshot.company} · Owner/HR read-only</p>}
        {message && <p role="status">{message}</p>}
      </section>
      {snapshot && (
        <>
          <section
            className="settings-card device-workspace"
            aria-label="Review device selection"
          >
            <div className="device-form">
              <label>
                Review device
                <select
                  disabled={busy}
                  value={position.deviceId ?? ''}
                  onChange={(e) =>
                    void refresh({
                      ...position,
                      deviceId: e.target.value,
                      events: null,
                    })
                  }
                >
                  <option value="">Select device</option>
                  {snapshot.devices.items.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.code} · {v.name} · {v.status}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!snapshot.devices.items.length && (
              <p>No devices on this page. Register a draft device first.</p>
            )}
            <div className="device-controls">
              <button
                className="secondary-button"
                disabled={busy || !position.devices}
                onClick={() => void refresh()}
              >
                First review devices page
              </button>
              <button
                className="secondary-button"
                disabled={busy || !snapshot.devices.nextCursor}
                onClick={() =>
                  void refresh({
                    devices: snapshot.devices.nextCursor,
                    events: null,
                    deviceId: null,
                  })
                }
              >
                Next review devices page
              </button>
            </div>
          </section>
          {chosen && (
            <>
              <section
                className="settings-card device-workspace"
                aria-label="Quarantined events"
              >
                <h2>Quarantined events · {chosen.code}</h2>
                <p>
                  Source identity and device clock are unverified. Local punch
                  times have no verified UTC conversion. Retired device history
                  remains read-only.
                </p>
                {!snapshot.inbox?.items.length && (
                  <p>No quarantined records on this page.</p>
                )}
                {snapshot.inbox?.items.map((row) => (
                  <article className="mapping-record" key={row.id}>
                    <h3>Source user {row.payload.sourceUserId}</h3>
                    <p>Raw local time: {row.payload.sourceLocalTimestamp}</p>
                    <p>Quarantine: {row.quarantineCode}</p>
                    <p>
                      Direction: {row.payload.direction ?? 'Not supplied'} ·
                      Work code: {row.payload.workCode ?? 'Not supplied'}
                    </p>
                    <small>
                      Source event ID:{' '}
                      {row.payload.sourceEventId ?? 'Not supplied'} · Canonical
                      event ID: {row.id} · Received UTC: {row.createdAt}
                    </small>
                  </article>
                ))}
                <div className="device-controls">
                  <button
                    className="secondary-button"
                    disabled={busy || !position.events}
                    onClick={() => void refresh({ ...position, events: null })}
                  >
                    First events page
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !snapshot.inbox?.nextCursor}
                    onClick={() =>
                      void refresh({
                        ...position,
                        events: snapshot.inbox!.nextCursor,
                      })
                    }
                  >
                    Next events page
                  </button>
                </div>
              </section>
              <form
                className="settings-card device-form"
                aria-label="Mapping preview"
                onSubmit={resolve}
              >
                <h2>What-if mapping preview</h2>
                <p>
                  Uses the persisted source user ID and complete mapping
                  history. Enter a hypothetical instant explicitly; it is not a
                  verified punch time. A match never clears quarantine.
                </p>
                <fieldset disabled={busy || !snapshot.inbox?.items.length}>
                  <label>
                    Quarantined event
                    <select
                      required
                      value={eventId}
                      onChange={(e) => {
                        setEventId(e.target.value);
                        setPreview(null);
                        setMessage('');
                      }}
                    >
                      <option value="">Select record from this page</option>
                      {snapshot.inbox?.items.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.payload.sourceUserId} ·{' '}
                          {v.payload.sourceLocalTimestamp} · {v.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Hypothetical instant (UTC or explicit offset)
                    <input
                      required
                      value={at}
                      onChange={(e) => {
                        setAt(e.target.value);
                        setPreview(null);
                        setMessage('');
                      }}
                      placeholder="2026-10-10T09:00:00+05:00"
                      autoComplete="off"
                    />
                  </label>
                  <button className="primary-button" type="submit">
                    Preview employee mapping
                  </button>
                </fieldset>
                {preview && (
                  <div role="status" className="mapping-record">
                    <p>
                      Operator-supplied unverified instant:{' '}
                      {preview.requestedAt}
                    </p>
                    <p>
                      {preview.resolution.status === 'mapped'
                        ? `Mapped to employee ${preview.resolution.employeeId} · mapping ${preview.resolution.mappingId} version ${preview.resolution.mappingVersion}`
                        : preview.resolution.status === 'unmapped'
                          ? 'Unmapped: no employee is guessed.'
                          : 'Ambiguous: review required; no employee is guessed.'}
                    </p>
                    <p>
                      Still quarantined. Source identity unverified · clock
                      unverified · attendance processing unavailable.
                    </p>
                  </div>
                )}
              </form>
            </>
          )}
        </>
      )}
    </>
  );
}
