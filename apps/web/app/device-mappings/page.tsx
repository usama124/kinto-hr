'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  deviceInventorySchema,
  employeeRosterSchema,
  tenantIdSchema,
  deviceMappingListSchema,
  deviceMappingCreateSchema,
  deviceMappingEndSchema,
  deviceMappingMutationSchema,
  deviceMappingResolveQuerySchema,
  deviceMappingResolutionSchema,
  type DeviceMappingCreate,
  type DeviceMappingEnd,
} from '@kinto/contracts';

type View =
  'loading' | 'ready' | 'signed-out' | 'select-company' | 'denied' | 'error';
type Scope = {
  tenantId: string;
  identityId: string;
  company: string;
  owner: boolean;
};
type Snapshot = Scope & {
  devices: ReturnType<typeof deviceInventorySchema.parse>;
  employees: ReturnType<typeof employeeRosterSchema.parse>;
  mappings: ReturnType<typeof deviceMappingListSchema.parse> | null;
};
type Attempt = {
  tenantId: string;
  identityId: string;
  deviceId: string;
  key: string;
} & (
  | { kind: 'create'; input: DeviceMappingCreate }
  | { kind: 'end'; id: string; input: DeviceMappingEnd }
);
type Position = {
  devices: string | null;
  mappings: string | null;
  deviceId: string | null;
};
const first: Position = { devices: null, mappings: null, deviceId: null };
const base = (tenant: string, device: string) =>
  `/api/v1/tenants/${tenant}/devices/${device}/employee-mappings`;
function pageValid(
  page: { items: { id: string }[]; nextCursor: string | null },
  after: string | null,
) {
  if (
    page.items.length > 25 ||
    page.items.some(
      (v, i) =>
        (after !== null && v.id <= after) ||
        (i > 0 && v.id <= page.items[i - 1].id),
    ) ||
    (page.nextCursor !== null &&
      (page.items.length !== 25 || page.nextCursor !== page.items.at(-1)?.id))
  )
    throw new Error('Invalid page');
}
export default function DeviceMappings() {
  const [view, setView] = useState<View>('loading'),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [position, setPosition] = useState<Position>(first),
    [pending, setPending] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [message, setMessage] = useState('');
  const [employee, setEmployee] = useState(''),
    [source, setSource] = useState(''),
    [from, setFrom] = useState(''),
    [until, setUntil] = useState('');
  const [ending, setEnding] = useState(''),
    [endAt, setEndAt] = useState('');
  const [lookupSource, setLookupSource] = useState(''),
    [lookupAt, setLookupAt] = useState('');
  const [resolution, setResolution] = useState<ReturnType<
    typeof deviceMappingResolutionSchema.parse
  > | null>(null);
  const alive = useRef(false),
    flight = useRef(false),
    pendingRef = useRef<Attempt | null>(null);
  function retain(attempt: Attempt | null) {
    pendingRef.current = attempt;
    setPending(attempt);
  }
  function forms() {
    setEmployee('');
    setSource('');
    setFrom('');
    setUntil('');
    setEnding('');
    setEndAt('');
    setLookupSource('');
    setLookupAt('');
    setResolution(null);
  }
  function clear(next: View) {
    setSnapshot(null);
    forms();
    retain(null);
    setPosition(first);
    setNeedsRefresh(false);
    setMessage('');
    setView(next);
  }
  function access(status: number) {
    if (![401, 403, 404].includes(status)) return false;
    clear(status === 401 ? 'signed-out' : 'denied');
    return true;
  }
  async function session(signal?: AbortSignal) {
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
      !('csrfToken' in raw) ||
      typeof raw.csrfToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(raw.csrfToken) ||
      !('tenants' in raw) ||
      !Array.isArray(raw.tenants)
    )
      throw new Error('Invalid session');
    const identityId = tenantIdSchema.parse(raw.identityId);
    const company = raw.tenants.find(
      (v: unknown) =>
        v && typeof v === 'object' && 'id' in v && v.id === tenantId,
    );
    if (
      !company ||
      typeof company.name !== 'string' ||
      !company.name ||
      !Array.isArray(company.roles)
    )
      throw new Error('Invalid company');
    const owner = company.roles.includes('owner');
    if (!owner && !company.roles.includes('hr_admin')) {
      clear('denied');
      return null;
    }
    return {
      tenantId,
      identityId,
      company: company.name as string,
      owner,
      csrf: raw.csrfToken,
    };
  }
  function same(scope: Pick<Scope, 'tenantId' | 'identityId'>, current: Scope) {
    return (
      scope.tenantId === current.tenantId &&
      scope.identityId === current.identityId
    );
  }
  async function load(next: Position, signal?: AbortSignal) {
    const previous = snapshot;
    setSnapshot(null);
    forms();
    setView('loading');
    const current = await session(signal);
    if (!current) return;
    if (previous && !same(previous, current)) next = first;
    if (
      pendingRef.current &&
      (!same(pendingRef.current, current) || !current.owner)
    )
      retain(null);
    const responses = await Promise.all([
      fetch(
        `/api/v1/tenants/${current.tenantId}/devices?limit=25${next.devices ? '&afterId=' + next.devices : ''}`,
        { cache: 'no-store', signal },
      ),
      fetch(`/api/v1/tenants/${current.tenantId}/employees`, {
        cache: 'no-store',
        signal,
      }),
    ]);
    if (!alive.current || signal?.aborted) return;
    for (const status of [401, 403, 404])
      if (responses.some((r) => r.status === status)) {
        access(status);
        return;
      }
    if (responses.some((r) => !r.ok)) throw new Error('Read unavailable');
    const [deviceRaw, employeeRaw]: unknown[] = await Promise.all(
      responses.map((r) => r.json()),
    );
    const devices = deviceInventorySchema.parse(deviceRaw),
      employees = employeeRosterSchema.parse(employeeRaw);
    pageValid(devices, next.devices);
    if (
      new Set(employees.employees.map((v) => v.id)).size !==
      employees.employees.length
    )
      throw new Error('Duplicate employee');
    const chosen =
      devices.items.find((v) => v.id === next.deviceId) ?? devices.items[0];
    let mappings: Snapshot['mappings'] = null;
    if (chosen) {
      const cursor = chosen.id === next.deviceId ? next.mappings : null;
      const response = await fetch(
        base(current.tenantId, chosen.id) +
          `?limit=25${cursor ? '&afterId=' + cursor : ''}`,
        { cache: 'no-store', signal },
      );
      if (!alive.current || signal?.aborted) return;
      if (access(response.status)) return;
      if (!response.ok) throw new Error('Mappings unavailable');
      mappings = deviceMappingListSchema.parse(await response.json());
      if (
        mappings.tenantId !== current.tenantId ||
        mappings.deviceId !== chosen.id ||
        mappings.items.some((v) => v.deviceId !== chosen.id)
      )
        throw new Error('Wrong mapping scope');
      pageValid(mappings, cursor);
      next = { ...next, deviceId: chosen.id, mappings: cursor };
    } else next = { ...next, deviceId: null, mappings: null };
    if (!alive.current || signal?.aborted) return;
    // CSRF remains ephemeral; it is never retained in a data snapshot.
    setSnapshot({
      tenantId: current.tenantId,
      identityId: current.identityId,
      company: current.company,
      owner: current.owner,
      devices,
      employees,
      mappings,
    });
    setPosition(next);
    setNeedsRefresh(false);
    setView('ready');
  }
  useEffect(() => {
    alive.current = true;
    flight.current = true;
    setBusy(true);
    const controller = new AbortController();
    void load(first, controller.signal)
      .catch(() => {
        if (alive.current && !controller.signal.aborted) {
          setSnapshot(null);
          forms();
          setView('error');
        }
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
    setMessage('');
    try {
      await load(next);
    } catch {
      if (alive.current) {
        setSnapshot(null);
        forms();
        setView('error');
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function command(attempt: Attempt) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setMessage('');
    setResolution(null);
    retain(attempt);
    try {
      const current = await session();
      if (!current) return;
      if (!same(attempt, current) || !current.owner) {
        clear('denied');
        return;
      }
      const response = await fetch(
        base(attempt.tenantId, attempt.deviceId) +
          (attempt.kind === 'end' ? `/${attempt.id}/end` : ''),
        {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': current.csrf,
            'Idempotency-Key': attempt.key,
          },
          body: JSON.stringify(attempt.input),
        },
      );
      if (!alive.current) return;
      if (access(response.status)) return;
      if ([400, 409].includes(response.status)) {
        retain(null);
        setNeedsRefresh(true);
        setMessage(
          'Change rejected. Refresh current history before making another change.',
        );
        return;
      }
      if (!response.ok) throw new Error('Uncertain');
      const result = deviceMappingMutationSchema.parse(await response.json());
      if (!alive.current) return;
      if (
        (attempt.kind === 'create' && result.version !== 1) ||
        (attempt.kind === 'end' &&
          (result.id !== attempt.id ||
            result.version !== attempt.input.expectedVersion + 1))
      )
        throw new Error('Invalid receipt');
      retain(null);
      setNeedsRefresh(true);
      forms();
      setMessage(
        result.replayed
          ? 'Exact request reconciled. Refresh history before another change.'
          : 'Change confirmed. Refresh history before another change.',
      );
    } catch {
      if (alive.current) {
        setSnapshot(null);
        forms();
        setView('error');
        setNeedsRefresh(true);
        setMessage(
          'Outcome unknown. New changes are locked. Refresh history or retry this exact request.',
        );
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (
      !snapshot?.owner ||
      blocked ||
      !chosen ||
      chosen.status !== 'draft' ||
      !eligible.some((v) => v.id === employee)
    )
      return;
    const input = deviceMappingCreateSchema.safeParse({
      employeeId: employee,
      sourceUserId: source,
      effectiveFrom: from,
      effectiveUntil: until || null,
      reason: 'initial_mapping',
    });
    if (!input.success) {
      setMessage(
        'Enter an exact source ID and valid offset timestamps; end must follow start.',
      );
      return;
    }
    void command({
      tenantId: snapshot.tenantId,
      identityId: snapshot.identityId,
      deviceId: chosen.id,
      key: crypto.randomUUID(),
      kind: 'create',
      input: input.data,
    });
  }
  function end(event: FormEvent) {
    event.preventDefault();
    const row = snapshot?.mappings?.items.find((v) => v.id === ending);
    if (!snapshot?.owner || blocked || !chosen || !row) return;
    const input = deviceMappingEndSchema.safeParse({
      expectedVersion: row.version,
      effectiveUntil: endAt,
      reason: 'end_mapping',
    });
    if (
      !input.success ||
      Date.parse(input.data.effectiveUntil) <= Date.parse(row.effectiveFrom) ||
      (row.effectiveUntil !== null &&
        Date.parse(input.data.effectiveUntil) >= Date.parse(row.effectiveUntil))
    ) {
      setMessage(
        'End must follow the original start and shorten the existing interval.',
      );
      return;
    }
    if (
      !window.confirm(
        `End source ID ${row.sourceUserId} at ${input.data.effectiveUntil}? Existing history is retained.`,
      )
    )
      return;
    void command({
      tenantId: snapshot.tenantId,
      identityId: snapshot.identityId,
      deviceId: chosen.id,
      key: crypto.randomUUID(),
      kind: 'end',
      id: row.id,
      input: input.data,
    });
  }
  async function resolve(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || !chosen || flight.current) return;
    setResolution(null);
    setMessage('');
    const input = deviceMappingResolveQuerySchema.safeParse({
      sourceUserId: lookupSource,
      at: lookupAt,
    });
    if (!input.success) {
      setMessage('Enter an exact source ID and a valid offset timestamp.');
      return;
    }
    flight.current = true;
    setBusy(true);
    try {
      const current = await session();
      if (!current) return;
      if (!same(snapshot, current) || (snapshot.owner && !current.owner)) {
        clear('denied');
        return;
      }
      const query = new URLSearchParams(input.data);
      const response = await fetch(
        base(snapshot.tenantId, chosen.id) + '/resolve?' + query,
        { cache: 'no-store' },
      );
      if (!alive.current) return;
      if (access(response.status)) return;
      if (!response.ok) throw new Error('Read failed');
      const result = deviceMappingResolutionSchema.parse(await response.json());
      if (alive.current) setResolution(result);
    } catch {
      if (alive.current) {
        setSnapshot(null);
        forms();
        setView('error');
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const blocked = busy || !!pending || needsRefresh;
  const chosen = snapshot?.devices.items.find(
    (v) => v.id === position.deviceId,
  );
  const eligible =
    snapshot?.employees.employees.filter(
      (v) => v.status !== 'archived' && v.archivedAt === null,
    ) ?? [];
  const employeeName = (id: string) =>
    snapshot?.employees.employees.find((v) => v.id === id)?.name ?? id;
  return (
    <>
      <section className="page-header">
        <p className="eyebrow">PHASE 2 · PREPARATORY MAPPINGS</p>
        <h1>Device employee mappings</h1>
        <p>
          Assign exact device user IDs to employees over effective dates. No K50
          polling, attendance processing or payroll effects.
        </p>
        <Link href="/devices">Attendance devices</Link>
      </section>
      <section
        className="settings-card device-workspace"
        aria-label="Mapping status"
      >
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh mapping metadata
        </button>
        {view === 'loading' && (
          <p>Loading current company and mapping metadata…</p>
        )}
        {view === 'signed-out' && <p>Sign in to view device mappings.</p>}
        {view === 'select-company' && (
          <p>
            Select a company before viewing device mappings.{' '}
            <Link href="/login">Account access</Link>
          </p>
        )}
        {view === 'denied' && (
          <p>
            Mapping access denied or context changed. Sign in with recent MFA
            and select an authorized company.
          </p>
        )}
        {view === 'error' && (
          <p>
            Mapping data is unavailable or invalid. Refresh to load current
            records.
          </p>
        )}
        {snapshot && (
          <p>
            {snapshot.company} ·{' '}
            {snapshot.owner ? 'Owner management' : 'HR read-only'}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {pending && (
          <>
            <p>
              Uncertain {pending.kind} request is retained in memory. Other
              writes remain locked, even after refresh.
            </p>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void command(pending)}
            >
              Retry exact mapping request
            </button>
          </>
        )}
      </section>
      {snapshot && (
        <>
          <section
            className="settings-card device-workspace"
            aria-label="Device selection"
          >
            <div className="device-form">
              <label>
                Device
                <select
                  value={position.deviceId ?? ''}
                  disabled={busy}
                  onChange={(e) =>
                    void refresh({
                      ...position,
                      deviceId: e.target.value,
                      mappings: null,
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
                First devices page
              </button>
              <button
                className="secondary-button"
                disabled={busy || !snapshot.devices.nextCursor}
                onClick={() =>
                  void refresh({
                    devices: snapshot.devices.nextCursor,
                    mappings: null,
                    deviceId: null,
                  })
                }
              >
                Next devices page
              </button>
            </div>
          </section>
          {chosen && (
            <>
              <section
                className="settings-card device-workspace"
                aria-label="Mapping history"
              >
                <h2>Mapping history · {chosen.code}</h2>
                <p>
                  Times shown in UTC. Source IDs retain leading zeros and case.
                  End is exclusive; unbounded means no end date.
                </p>
                {!snapshot.mappings?.items.length && (
                  <p>No mappings on this page.</p>
                )}
                {snapshot.mappings?.items.map((row) => (
                  <article className="mapping-record" key={row.id}>
                    <h3>Source ID {row.sourceUserId}</h3>
                    <p>{employeeName(row.employeeId)}</p>
                    <small>Employee ID: {row.employeeId}</small>
                    <p>
                      {row.effectiveFrom} → {row.effectiveUntil ?? 'Unbounded'}{' '}
                      · version {row.version}
                    </p>
                    <small>Mapping ID: {row.id}</small>
                  </article>
                ))}
                <div className="device-controls">
                  <button
                    className="secondary-button"
                    disabled={busy || !position.mappings}
                    onClick={() =>
                      void refresh({ ...position, mappings: null })
                    }
                  >
                    First mappings page
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !snapshot.mappings?.nextCursor}
                    onClick={() =>
                      void refresh({
                        ...position,
                        mappings: snapshot.mappings!.nextCursor,
                      })
                    }
                  >
                    Next mappings page
                  </button>
                </div>
              </section>
              {snapshot.owner && (
                <>
                  <form
                    className="settings-card device-form"
                    aria-label="Create mapping"
                    onSubmit={create}
                  >
                    <h2>Create mapping</h2>
                    {chosen.status === 'retired' && (
                      <p>Retired devices cannot receive new mappings.</p>
                    )}
                    <fieldset disabled={blocked || chosen.status !== 'draft'}>
                      <label>
                        Employee
                        <select
                          required
                          value={employee}
                          onChange={(e) => setEmployee(e.target.value)}
                        >
                          <option value="">Select employee</option>
                          {eligible.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.employeeNumber} · {v.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Source user ID
                        <input
                          required
                          maxLength={64}
                          value={source}
                          onChange={(e) => setSource(e.target.value)}
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        Effective start (UTC or explicit offset)
                        <input
                          required
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                          placeholder="2026-10-07T09:00:00+05:00"
                        />
                      </label>
                      <label>
                        Effective end (optional, exclusive)
                        <input
                          value={until}
                          onChange={(e) => setUntil(e.target.value)}
                          placeholder="Leave empty for unbounded"
                        />
                      </label>
                      <button className="primary-button" type="submit">
                        Create employee mapping
                      </button>
                    </fieldset>
                    <p>
                      No employee guess or overlap replacement is allowed.
                      Company-wide policies and employment qualification are
                      separate.
                    </p>
                  </form>
                  <form
                    className="settings-card device-form"
                    aria-label="End mapping"
                    onSubmit={end}
                  >
                    <h2>End an assignment</h2>
                    <fieldset disabled={blocked}>
                      <label>
                        Mapping to end
                        <select
                          required
                          value={ending}
                          onChange={(e) => setEnding(e.target.value)}
                        >
                          <option value="">
                            Select mapping from this page
                          </option>
                          {snapshot.mappings?.items.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.sourceUserId} · {employeeName(v.employeeId)} ·
                              version {v.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        New exclusive end (UTC or explicit offset)
                        <input
                          required
                          value={endAt}
                          onChange={(e) => setEndAt(e.target.value)}
                        />
                      </label>
                      <button className="primary-button" type="submit">
                        End employee mapping
                      </button>
                    </fieldset>
                    <p>
                      Only shorten an interval after its original start. Source
                      ID, employee and original start cannot be rewritten.
                    </p>
                  </form>
                </>
              )}
              <form
                className="settings-card device-form"
                aria-label="Resolve mapping"
                onSubmit={resolve}
              >
                <h2>Resolve at event time</h2>
                <p>
                  Administrative lookup uses full history, not just this page.
                  It does not calculate attendance.
                </p>
                <fieldset disabled={busy || !!pending || needsRefresh}>
                  <label>
                    Lookup source ID
                    <input
                      required
                      value={lookupSource}
                      onChange={(e) => {
                        setLookupSource(e.target.value);
                        setResolution(null);
                      }}
                    />
                  </label>
                  <label>
                    Event instant (UTC or explicit offset)
                    <input
                      required
                      value={lookupAt}
                      onChange={(e) => {
                        setLookupAt(e.target.value);
                        setResolution(null);
                      }}
                    />
                  </label>
                  <button className="primary-button" type="submit">
                    Resolve employee mapping
                  </button>
                </fieldset>
                {resolution && (
                  <p role="status">
                    {resolution.status === 'mapped'
                      ? `Mapped to ${employeeName(resolution.employeeId)} · ${resolution.employeeId} · mapping ${resolution.mappingId} version ${resolution.mappingVersion}`
                      : resolution.status === 'unmapped'
                        ? 'Unmapped: no employee is guessed.'
                        : 'Ambiguous: review is required; no employee is guessed.'}
                  </p>
                )}
              </form>
            </>
          )}
        </>
      )}
    </>
  );
}
