'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  tenantIdSchema,
  attendanceTimingPolicyDraftSchema,
  attendanceTimingPublishSchema,
  attendanceTimingListSchema,
  attendanceTimingPreviewSchema,
  attendanceTimingMutationSchema,
  type AttendanceTimingPolicyDraft,
  type AttendanceTimingPublish,
} from '@kinto/contracts';

type View =
  'loading' | 'ready' | 'signed-out' | 'select-company' | 'denied' | 'error';
type Scope = {
  tenantId: string;
  identityId: string;
  company: string;
  owner: boolean;
};
type History = ReturnType<typeof attendanceTimingListSchema.parse>;
type Preview = ReturnType<typeof attendanceTimingPreviewSchema.parse>;
type Attempt = Pick<Scope, 'tenantId' | 'identityId'> & { key: string } & (
    | { kind: 'draft'; input: AttendanceTimingPolicyDraft }
    | { kind: 'publication'; id: string; input: AttendanceTimingPublish }
  );
const minutes = [
  ['unpaidBreakMinutes', 'Unpaid break minutes'],
  ['fullDayTargetMinutes', 'Full day target minutes'],
  ['halfDayTargetMinutes', 'Half day target minutes'],
  ['minimumFullDayMinutes', 'Minimum full day minutes'],
  ['minimumHalfDayMinutes', 'Minimum half day minutes'],
  ['lateGraceMinutes', 'Late grace minutes'],
  ['earlyGraceMinutes', 'Early grace minutes'],
  ['associationBeforeMinutes', 'Association before minutes'],
  ['associationAfterMinutes', 'Association after minutes'],
] as const;
const emptyMinutes = () =>
  Object.fromEntries(minutes.map(([key]) => [key, ''])) as Record<
    (typeof minutes)[number][0],
    string
  >;
const weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const base = (tenant: string) =>
  `/api/v1/tenants/${tenant}/organization/policies/attendance-timing`;
const same = (a: Pick<Scope, 'tenantId' | 'identityId'>, b: Scope) =>
  a.tenantId === b.tenantId && a.identityId === b.identityId;

export default function AttendanceTiming() {
  const [view, setView] = useState<View>('loading'),
    [scope, setScope] = useState<Scope | null>(null);
  const [history, setHistory] = useState<History | null>(null),
    [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [message, setMessage] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null);
  const [checkIn, setCheckIn] = useState(''),
    [checkOut, setCheckOut] = useState(''),
    [overnight, setOvernight] = useState(false);
  const [values, setValues] = useState(emptyMinutes),
    [restDays, setRestDays] = useState<number[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(today),
    [reason, setReason] = useState(''),
    [publicationReason, setPublicationReason] = useState('');
  const alive = useRef(false),
    flight = useRef(false),
    pendingRef = useRef<Attempt | null>(null);
  function retain(value: Attempt | null) {
    pendingRef.current = value;
    setPending(value);
  }
  function forms() {
    setCheckIn('');
    setCheckOut('');
    setOvernight(false);
    setValues(emptyMinutes());
    setRestDays([]);
    setEffectiveFrom(today());
    setReason('');
    setPublicationReason('');
    setPreview(null);
  }
  function clear(next: View) {
    setScope(null);
    setHistory(null);
    forms();
    retain(null);
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
  async function recheck(current: Scope, signal?: AbortSignal) {
    const fresh = await session(signal);
    if (!fresh) return null;
    if (!same(current, fresh) || current.owner !== fresh.owner) {
      clear('denied');
      return null;
    }
    return fresh;
  }
  async function load(cursor: string | null, signal?: AbortSignal) {
    const previous = scope;
    setScope(null);
    setHistory(null);
    forms();
    setView('loading');
    const current = await session(signal);
    if (!current) return;
    if (
      previous &&
      (!same(previous, current) || previous.owner !== current.owner)
    )
      cursor = null;
    if (
      pendingRef.current &&
      (!same(pendingRef.current, current) || !current.owner)
    )
      retain(null);
    const response = await fetch(
      base(current.tenantId) + `?limit=25${cursor ? '&afterId=' + cursor : ''}`,
      { cache: 'no-store', signal },
    );
    if (!alive.current || signal?.aborted || access(response.status)) return;
    if (!response.ok) throw new Error('Unavailable');
    const data = attendanceTimingListSchema.parse(await response.json());
    if (
      data.tenantId !== current.tenantId ||
      data.asOf !== today() ||
      data.items.length > 25 ||
      data.items.some(
        (v, i) =>
          (cursor !== null && v.id <= cursor) ||
          (i > 0 && v.id <= data.items[i - 1].id) ||
          (v.status === 'published' && v.version > data.latestPublishedVersion),
      ) ||
      (data.nextCursor !== null &&
        (data.items.length !== 25 ||
          data.nextCursor !== data.items.at(-1)?.id)) ||
      (data.currentPolicy &&
        (data.currentPolicy.status !== 'published' ||
          data.currentPolicy.effectiveFrom > data.asOf ||
          data.currentPolicy.version > data.latestPublishedVersion))
    )
      throw new Error('Invalid history');
    if (!(await recheck(current, signal)) || !alive.current || signal?.aborted)
      return;
    setScope(current);
    setHistory(data);
    setNeedsRefresh(false);
    setView('ready');
  }
  useEffect(() => {
    alive.current = true;
    flight.current = true;
    const controller = new AbortController();
    void load(null, controller.signal)
      .catch(() => {
        if (alive.current && !controller.signal.aborted) clear('error');
      })
      .finally(() => {
        flight.current = false;
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
    // Initial load only; actions explicitly reload with fresh authority.
  }, []);
  async function refresh(cursor: string | null = null) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setMessage('');
    try {
      await load(cursor);
    } catch {
      if (alive.current) {
        setScope(null);
        setHistory(null);
        forms();
        setView('error');
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function inspect(id: string) {
    if (
      !scope ||
      !history ||
      flight.current ||
      pendingRef.current ||
      needsRefresh
    )
      return;
    const current = scope,
      listed = history.items.find((v) => v.id === id) ?? history.currentPolicy;
    if (!listed || listed.id !== id) return;
    flight.current = true;
    setBusy(true);
    setPreview(null);
    setPublicationReason('');
    setMessage('');
    try {
      if (!(await recheck(current))) return;
      const response = await fetch(base(current.tenantId) + `/${id}/preview`, {
        cache: 'no-store',
      });
      if (!alive.current || access(response.status)) return;
      if (!response.ok) throw new Error('Unavailable');
      const data = attendanceTimingPreviewSchema.parse(await response.json());
      if (
        data.tenantId !== current.tenantId ||
        JSON.stringify(data.policy) !== JSON.stringify(listed)
      )
        throw new Error('Invalid preview');
      const s = data.policy.settings;
      const start =
        Number(s.checkIn.slice(0, 2)) * 60 + Number(s.checkIn.slice(3));
      const end =
        Number(s.checkOut.slice(0, 2)) * 60 +
        Number(s.checkOut.slice(3)) +
        (s.checkOutNextDay ? 1440 : 0);
      if (
        data.scheduledMinutes !== end - start ||
        data.netScheduledMinutes !== end - start - s.unpaidBreakMinutes ||
        data.associationWindow.fromLocalMinute !==
          start - s.associationBeforeMinutes ||
        data.associationWindow.untilLocalMinute !==
          end + s.associationAfterMinutes
      )
        throw new Error('Invalid arithmetic');
      if (!(await recheck(current)) || !alive.current) return;
      setPreview(data);
    } catch {
      if (alive.current) clear('error');
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
    retain(attempt);
    setPreview(null);
    try {
      const current = await session();
      if (!current) return;
      if (!same(attempt, current) || !current.owner) {
        clear('denied');
        return;
      }
      const response = await fetch(
        base(attempt.tenantId) +
          (attempt.kind === 'draft' ? '/drafts' : `/${attempt.id}/publication`),
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
      if (!alive.current || access(response.status)) return;
      if (!(await recheck(current)) || !alive.current) return;
      if ([400, 409].includes(response.status)) {
        retain(null);
        forms();
        setNeedsRefresh(true);
        setMessage('Change rejected. Refresh history before another change.');
        return;
      }
      if (!response.ok) throw new Error('Uncertain');
      const receipt = attendanceTimingMutationSchema.parse(
        await response.json(),
      );
      if (
        (attempt.kind === 'draft' &&
          receipt.version <= attempt.input.expectedCurrentVersion) ||
        (attempt.kind === 'publication' &&
          (receipt.id !== attempt.id ||
            receipt.version !== attempt.input.expectedVersion))
      )
        throw new Error('Invalid receipt');
      if (!alive.current) return;
      retain(null);
      forms();
      setNeedsRefresh(true);
      setMessage(
        receipt.replayed
          ? 'Exact timing request reconciled. Refresh history before another change.'
          : 'Timing change confirmed. Refresh history before another change.',
      );
    } catch {
      if (alive.current) {
        setScope(null);
        setHistory(null);
        forms();
        setView('error');
        setNeedsRefresh(true);
        setMessage(
          'Outcome unknown. New changes are locked. Refresh or retry the exact timing request.',
        );
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (!scope?.owner || !history || busy || pending || needsRefresh) return;
    const input = attendanceTimingPolicyDraftSchema.safeParse({
      expectedCurrentVersion: history.latestPublishedVersion,
      effectiveFrom,
      reason,
      settings: {
        scope: 'company',
        timeZone: 'Asia/Karachi',
        breakMode: 'fixed_duration',
        checkIn,
        checkOut,
        checkOutNextDay: overnight,
        ...Object.fromEntries(
          minutes.map(([k]) => [k, values[k] === '' ? NaN : Number(values[k])]),
        ),
        weeklyRestDays: restDays,
      },
    });
    if (!input.success || effectiveFrom < today()) {
      setMessage(
        'Invalid timing settings. Check shift length, breaks, targets, minimums and association bounds.',
      );
      return;
    }
    if (
      !window.confirm(
        'Create this company-wide timing draft? It will not affect attendance or payroll.',
      )
    )
      return;
    void command({
      tenantId: scope.tenantId,
      identityId: scope.identityId,
      key: crypto.randomUUID(),
      kind: 'draft',
      input: input.data,
    });
  }
  function publish(event: FormEvent) {
    event.preventDefault();
    if (
      !scope?.owner ||
      !history ||
      !preview ||
      busy ||
      pending ||
      needsRefresh
    )
      return;
    const policy = preview.policy;
    const input = attendanceTimingPublishSchema.safeParse({
      expectedVersion: policy.version,
      reason: publicationReason,
    });
    if (
      !input.success ||
      policy.status !== 'draft' ||
      policy.basedOnVersion !== history.latestPublishedVersion ||
      policy.effectiveFrom < today()
    ) {
      setMessage(
        'Draft is stale or publication reason is invalid. Refresh history.',
      );
      return;
    }
    if (
      !window.confirm(
        `Publish company-wide timing version ${policy.version} from ${policy.effectiveFrom}? Attendance and payroll calculation remain disabled.`,
      )
    )
      return;
    void command({
      tenantId: scope.tenantId,
      identityId: scope.identityId,
      key: crypto.randomUUID(),
      kind: 'publication',
      id: policy.id,
      input: input.data,
    });
  }
  const blocked = busy || !!pending || needsRefresh;
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">COMPANY POLICY · ASIA/KARACHI</span>
          <h1>Attendance timing</h1>
          <p>
            Company-wide timing definitions. Attendance and payroll calculation
            remain disabled.
          </p>
        </div>
        <Link className="secondary-button" href="/organization">
          Company setup
        </Link>
      </section>
      <section className="settings-card timing-workspace">
        <button
          className="secondary-button"
          disabled={busy || view === 'loading'}
          onClick={() => void refresh()}
        >
          Refresh timing history
        </button>
        {message && <p role="status">{message}</p>}
        {pending && (
          <div className="policy-preview">
            <p>
              Uncertain {pending.kind} request retained in memory. Refresh keeps
              its exact key and payload; new changes remain locked. Closing or
              reloading this tab loses the request; review history before
              proceeding.
            </p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void command(pending)}
            >
              Retry exact timing request
            </button>
          </div>
        )}
        {view === 'loading' && <p role="status">Loading timing history…</p>}
        {view === 'signed-out' && (
          <p>
            Sign in to view timing policies.{' '}
            <Link href="/login">Account access</Link>
          </p>
        )}
        {view === 'select-company' && (
          <p>Select a company in account access first.</p>
        )}
        {view === 'denied' && (
          <p>
            Owner or HR access with recent MFA is required. Displayed policies
            and pending commands were cleared.
          </p>
        )}
        {view === 'error' && (
          <p>
            Timing data is unavailable or invalid. Refresh to reload safely.
          </p>
        )}
        {view === 'ready' && scope && history && (
          <>
            <h2>{scope.company}</h2>
            <p>
              {scope.owner
                ? 'Owner · draft and publish access'
                : 'HR · read-only access'}
            </p>
            <p>
              Current policy as of {history.asOf}:{' '}
              {history.currentPolicy
                ? `Version ${history.currentPolicy.version} · from ${history.currentPolicy.effectiveFrom}`
                : 'Not published'}
              . Latest published version (including future schedules):{' '}
              {history.latestPublishedVersion}.
            </p>
            {history.currentPolicy && (
              <button
                className="secondary-button"
                disabled={blocked}
                onClick={() => void inspect(history.currentPolicy!.id)}
              >
                Preview current timing
              </button>
            )}
            <h3>Timing history</h3>
            {history.items.length === 0 && <p>No timing policies yet.</p>}
            <ul className="branch-list">
              {history.items.map((policy) => (
                <li key={policy.id}>
                  <div>
                    <strong>
                      Version {policy.version} · {policy.status}
                    </strong>
                    <small>
                      From {policy.effectiveFrom} · {policy.reason}
                    </small>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={blocked}
                    onClick={() => void inspect(policy.id)}
                  >
                    Preview version {policy.version}
                  </button>
                </li>
              ))}
            </ul>
            {history.nextCursor && (
              <button
                className="secondary-button"
                disabled={busy || !!pending}
                onClick={() => void refresh(history.nextCursor)}
              >
                Next timing page
              </button>
            )}
            {scope.owner && (
              <form
                className="settings-form"
                onSubmit={create}
                onChange={() => {
                  setPreview(null);
                  setPublicationReason('');
                }}
              >
                <h3>Create timing draft</h3>
                <fieldset disabled={blocked}>
                  <p>
                    All times are local to Asia/Karachi. Enter every duration
                    explicitly; zero is allowed for breaks, grace and
                    association offsets.
                  </p>
                  <label>
                    Check-in time
                    <input
                      required
                      type="time"
                      value={checkIn}
                      onChange={(e) => setCheckIn(e.target.value)}
                    />
                  </label>
                  <label>
                    Check-out time
                    <input
                      required
                      type="time"
                      value={checkOut}
                      onChange={(e) => setCheckOut(e.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={overnight}
                      onChange={(e) => setOvernight(e.target.checked)}
                    />
                    Check-out on next day
                  </label>
                  {minutes.map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        required
                        type="number"
                        min="0"
                        max="1439"
                        step="1"
                        value={values[key]}
                        onChange={(e) =>
                          setValues({ ...values, [key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                  <fieldset>
                    <legend>Weekly rest days</legend>
                    {weekdays.map((name, index) => (
                      <label key={name}>
                        <input
                          type="checkbox"
                          checked={restDays.includes(index + 1)}
                          onChange={(e) =>
                            setRestDays(
                              e.target.checked
                                ? [...restDays, index + 1].sort()
                                : restDays.filter((v) => v !== index + 1),
                            )
                          }
                        />
                        {name}
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    Effective from
                    <input
                      required
                      type="date"
                      min={today()}
                      value={effectiveFrom}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    Draft reason
                    <input
                      required
                      minLength={3}
                      maxLength={240}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button className="primary-button">
                    Create timing draft
                  </button>
                </fieldset>
              </form>
            )}
            {preview && (
              <form className="policy-preview" onSubmit={publish}>
                <h3>Preview timing version {preview.policy.version}</h3>
                <p>
                  {preview.policy.status} · from {preview.policy.effectiveFrom}{' '}
                  · based on version {preview.policy.basedOnVersion}
                </p>
                <p>
                  Check-in {preview.policy.settings.checkIn}; check-out{' '}
                  {preview.policy.settings.checkOut}
                  {preview.policy.settings.checkOutNextDay
                    ? ' on next day'
                    : ' on same day'}
                  . {preview.scheduledMinutes} scheduled minutes;{' '}
                  {preview.netScheduledMinutes} net scheduled minutes. These are
                  not worked or payable minutes.
                </p>
                <dl>
                  {minutes.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>{preview.policy.settings[key]}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>Weekly rest days</dt>
                    <dd>
                      {preview.policy.settings.weeklyRestDays
                        .map((v) => weekdays[v - 1])
                        .join(', ') || 'None'}
                    </dd>
                  </div>
                  <div>
                    <dt>Association window</dt>
                    <dd>
                      {preview.associationWindow.fromLocalMinute} to{' '}
                      {preview.associationWindow.untilLocalMinute} local
                      minutes; end exclusive, anchored to check-in local date.
                    </dd>
                  </div>
                </dl>
                {scope.owner && preview.policy.status === 'draft' && (
                  <fieldset
                    disabled={
                      blocked ||
                      preview.policy.basedOnVersion !==
                        history.latestPublishedVersion ||
                      preview.policy.effectiveFrom < today()
                    }
                  >
                    <label>
                      Publication reason
                      <input
                        required
                        minLength={3}
                        maxLength={240}
                        value={publicationReason}
                        onChange={(e) => setPublicationReason(e.target.value)}
                      />
                    </label>
                    <button className="primary-button">
                      Publish timing policy
                    </button>
                  </fieldset>
                )}
              </form>
            )}
          </>
        )}
      </section>
    </>
  );
}
