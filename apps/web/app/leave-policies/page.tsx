'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  tenantIdSchema,
  leaveTypeListSchema,
  leavePolicyListSchema,
  leavePolicyMutationSchema,
  leaveTypeCreateSchema,
  leavePolicyDraftInputSchema,
  leavePolicyPublishSchema,
  type LeavePolicyRecord,
} from '@kinto/contracts';
type View =
  'loading' | 'ready' | 'signed-out' | 'select-company' | 'denied' | 'error';
type Scope = {
  tenantId: string;
  identityId: string;
  company: string;
  owner: boolean;
};
type Catalog = ReturnType<typeof leaveTypeListSchema.parse>;
type History = ReturnType<typeof leavePolicyListSchema.parse>;
type Draft = ReturnType<typeof leavePolicyDraftInputSchema.parse>;
type Publish = ReturnType<typeof leavePolicyPublishSchema.parse>;
type Attempt = Pick<Scope, 'tenantId' | 'identityId'> & { key: string } & (
    | { kind: 'type'; input: Draft }
    | { kind: 'draft'; typeId: string; input: Draft }
    | { kind: 'publication'; typeId: string; id: string; input: Publish }
  );
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const base = (tenant: string) =>
  `/api/v1/tenants/${tenant}/organization/leave-types`;
const same = (a: Pick<Scope, 'tenantId' | 'identityId'>, b: Scope) =>
  a.tenantId === b.tenantId && a.identityId === b.identityId;
const empty = () => ({
  code: '',
  name: '',
  pay: '',
  annual: '',
  monthly: '',
  month: '',
  day: '',
  calendar: '',
});
function validPage(
  items: { id: string }[],
  cursor: string | null,
  next: string | null,
) {
  return (
    items.length <= 25 &&
    !items.some(
      (v, i) =>
        (cursor !== null && v.id <= cursor) ||
        (i > 0 && v.id <= items[i - 1].id),
    ) &&
    (next === null || (items.length === 25 && next === items.at(-1)?.id))
  );
}
export default function LeavePolicies() {
  const [view, setView] = useState<View>('loading'),
    [scope, setScope] = useState<Scope | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [history, setHistory] = useState<History | null>(null),
    [review, setReview] = useState<LeavePolicyRecord | null>(null);
  const [busy, setBusy] = useState(false),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [message, setMessage] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null),
    [values, setValues] = useState(empty);
  const [effectiveFrom, setEffectiveFrom] = useState(today),
    [reason, setReason] = useState(''),
    [publicationReason, setPublicationReason] = useState('');
  const alive = useRef(false),
    flight = useRef(false),
    pendingRef = useRef<Attempt | null>(null),
    typeRef = useRef<string | null>(null);
  const binding = useRef<Scope | null>(null);
  const typeCursor = useRef<string | null>(null),
    policyCursor = useRef<string | null>(null);
  function retain(value: Attempt | null) {
    pendingRef.current = value;
    setPending(value);
  }
  function forms() {
    setValues(empty());
    setEffectiveFrom(today());
    setReason('');
    setPublicationReason('');
    setReview(null);
  }
  function clear(next: View) {
    setScope(null);
    binding.current = null;
    setCatalog(null);
    setHistory(null);
    forms();
    retain(null);
    typeRef.current = null;
    typeCursor.current = null;
    policyCursor.current = null;
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
  async function load(
    selected: string | null,
    typesAfter: string | null = null,
    policiesAfter: string | null = null,
    signal?: AbortSignal,
  ) {
    const previous = binding.current;
    setScope(null);
    setCatalog(null);
    setHistory(null);
    forms();
    setView('loading');
    const current = await session(signal);
    if (!current) return;
    if (
      previous &&
      (!same(previous, current) || previous.owner !== current.owner)
    ) {
      selected = null;
      typesAfter = null;
      policiesAfter = null;
    }
    if (
      pendingRef.current &&
      (!same(pendingRef.current, current) || !current.owner)
    ) {
      retain(null);
      selected = null;
      typesAfter = null;
      policiesAfter = null;
    }
    const response = await fetch(
      base(current.tenantId) +
        `?limit=25${typesAfter ? '&afterId=' + typesAfter : ''}`,
      { cache: 'no-store', signal },
    );
    if (!alive.current || signal?.aborted || access(response.status)) return;
    if (!response.ok) throw new Error('Catalog unavailable');
    const types = leaveTypeListSchema.parse(await response.json());
    if (
      types.tenantId !== current.tenantId ||
      !validPage(types.items, typesAfter, types.nextCursor)
    )
      throw new Error('Invalid catalog');
    let policies: History | null = null;
    if (selected) {
      const asOf = today();
      const res = await fetch(
        base(current.tenantId) +
          `/${selected}/policies?limit=25&asOf=${asOf}${policiesAfter ? '&afterId=' + policiesAfter : ''}`,
        { cache: 'no-store', signal },
      );
      if (!alive.current || signal?.aborted || access(res.status)) return;
      if (!res.ok) throw new Error('Policies unavailable');
      policies = leavePolicyListSchema.parse(await res.json());
      const matches = (p: LeavePolicyRecord) =>
        p.tenantId === current.tenantId &&
        p.leaveTypeId === selected &&
        p.settings.code === policies!.leaveType.code;
      const currentPolicy = policies.currentPolicy;
      const listed = types.items.find((t) => t.id === selected);
      if (
        policies.tenantId !== current.tenantId ||
        policies.leaveType.id !== selected ||
        policies.asOf !== asOf ||
        (listed &&
          JSON.stringify(listed) !== JSON.stringify(policies.leaveType)) ||
        !validPage(policies.items, policiesAfter, policies.nextCursor) ||
        new Set(policies.items.map((p) => p.version)).size !==
          policies.items.length ||
        policies.items.some(
          (p) =>
            !matches(p) ||
            (p.status === 'published' &&
              p.version > policies!.latestPublishedVersion),
        ) ||
        (currentPolicy &&
          (!matches(currentPolicy) ||
            currentPolicy.status !== 'published' ||
            currentPolicy.effectiveFrom > asOf ||
            (currentPolicy.effectiveUntil !== null &&
              currentPolicy.effectiveUntil <= asOf) ||
            currentPolicy.version > policies.latestPublishedVersion)) ||
        (currentPolicy &&
          policies.items.some(
            (p) =>
              p.id === currentPolicy.id &&
              JSON.stringify(p) !== JSON.stringify(currentPolicy),
          ))
      )
        throw new Error('Invalid policies');
    }
    if (!(await recheck(current, signal)) || !alive.current || signal?.aborted)
      return;
    typeRef.current = selected;
    typeCursor.current = typesAfter;
    policyCursor.current = policiesAfter;
    binding.current = current;
    setScope(current);
    setCatalog(types);
    setHistory(policies);
    setNeedsRefresh(false);
    setView('ready');
  }
  useEffect(() => {
    alive.current = true;
    flight.current = true;
    const controller = new AbortController();
    void load(null, null, null, controller.signal)
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
    // Initial load only; subsequent actions fetch fresh authority explicitly.
  }, []);
  async function refresh(
    selected = typeRef.current,
    typesAfter: string | null = null,
    policiesAfter: string | null = null,
  ) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setMessage('');
    try {
      await load(selected, typesAfter, policiesAfter);
    } catch {
      if (alive.current) {
        setScope(null);
        setCatalog(null);
        setHistory(null);
        forms();
        setView('error');
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function inspect(policy: LeavePolicyRecord) {
    if (
      !scope ||
      !history ||
      flight.current ||
      pendingRef.current ||
      needsRefresh
    )
      return;
    const current = scope;
    flight.current = true;
    setBusy(true);
    setReview(null);
    setPublicationReason('');
    setMessage('');
    try {
      if (await recheck(current)) {
        if (alive.current) setReview(policy);
      }
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
    setReview(null);
    try {
      const current = await session();
      if (!current) return;
      if (!same(attempt, current) || !current.owner) {
        clear('denied');
        return;
      }
      const path =
        attempt.kind === 'type'
          ? ''
          : attempt.kind === 'draft'
            ? `/${attempt.typeId}/policies/drafts`
            : `/${attempt.typeId}/policies/${attempt.id}/publication`;
      const response = await fetch(base(attempt.tenantId) + path, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': current.csrf,
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.input),
      });
      if (!alive.current || access(response.status)) return;
      if (!(await recheck(current)) || !alive.current) return;
      if ([400, 409].includes(response.status)) {
        retain(null);
        forms();
        setNeedsRefresh(true);
        setMessage(
          'Change rejected. Refresh leave policies before another change.',
        );
        return;
      }
      if (!response.ok) throw new Error('Uncertain');
      const receipt = leavePolicyMutationSchema.parse(await response.json());
      if (
        (attempt.kind === 'type' && receipt.version !== 1) ||
        (attempt.kind !== 'type' && receipt.leaveTypeId !== attempt.typeId) ||
        (attempt.kind === 'draft' &&
          receipt.version <= attempt.input.expectedCurrentVersion) ||
        (attempt.kind === 'publication' &&
          (receipt.id !== attempt.id ||
            receipt.version !== attempt.input.expectedVersion))
      )
        throw new Error('Invalid receipt');
      if (!(await recheck(current)) || !alive.current) return;
      typeRef.current = receipt.leaveTypeId;
      retain(null);
      forms();
      setNeedsRefresh(true);
      setMessage(
        receipt.replayed
          ? 'Exact leave request reconciled. Refresh leave policies before another change.'
          : 'Leave policy change confirmed. Refresh leave policies before another change.',
      );
    } catch {
      if (alive.current) {
        setScope(null);
        setCatalog(null);
        setHistory(null);
        forms();
        setView('error');
        setNeedsRefresh(true);
        setMessage(
          'Outcome unknown. New changes are locked. Refresh or retry the exact leave request.',
        );
      }
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    if (!scope?.owner || !catalog || busy || pending || needsRefresh) return;
    if (typeRef.current && !history) return;
    const input = (
      history ? leavePolicyDraftInputSchema : leaveTypeCreateSchema
    ).safeParse({
      expectedCurrentVersion: history?.latestPublishedVersion ?? 0,
      effectiveFrom,
      reason,
      settings: {
        scope: 'company',
        timeZone: 'Asia/Karachi',
        code: history?.leaveType.code ?? values.code,
        name: values.name,
        pay: values.pay,
        grantMode: 'annual_upfront',
        annualQuotaDays: values.annual === '' ? NaN : Number(values.annual),
        monthlyQuotaDays: values.monthly === '' ? NaN : Number(values.monthly),
        leaveYearStart: {
          month: values.month === '' ? NaN : Number(values.month),
          day: values.day === '' ? NaN : Number(values.day),
        },
        nonWorkingDays: values.calendar,
      },
    });
    if (
      !input.success ||
      effectiveFrom < today() ||
      (history?.currentPolicy &&
        effectiveFrom <= history.currentPolicy.effectiveFrom)
    ) {
      setMessage(
        'Invalid leave settings. Enter explicit quotas in half-day increments, a recurring leave-year date and a prospective effective date.',
      );
      return;
    }
    if (
      !window.confirm(
        'Create this company-wide leave policy draft? Leave requests and payroll effects remain unavailable.',
      )
    )
      return;
    const binding = {
      tenantId: scope.tenantId,
      identityId: scope.identityId,
      key: crypto.randomUUID(),
    };
    void command(
      history
        ? {
            ...binding,
            kind: 'draft',
            typeId: history.leaveType.id,
            input: input.data,
          }
        : { ...binding, kind: 'type', input: input.data },
    );
  }
  function publish(event: FormEvent) {
    event.preventDefault();
    if (!scope?.owner || !history || !review || busy || pending || needsRefresh)
      return;
    const input = leavePolicyPublishSchema.safeParse({
      expectedVersion: review.version,
      reason: publicationReason,
    });
    if (
      !input.success ||
      review.status !== 'draft' ||
      review.basedOnVersion !== history.latestPublishedVersion ||
      review.effectiveFrom < today()
    ) {
      setMessage(
        'Draft is stale or publication reason is invalid. Refresh leave policies.',
      );
      return;
    }
    if (
      !window.confirm(
        `Publish ${review.settings.name} version ${review.version} from ${review.effectiveFrom}? Reservation and payroll effects remain unavailable.`,
      )
    )
      return;
    void command({
      tenantId: scope.tenantId,
      identityId: scope.identityId,
      key: crypto.randomUUID(),
      kind: 'publication',
      typeId: review.leaveTypeId,
      id: review.id,
      input: input.data,
    });
  }
  const blocked = busy || !!pending || needsRefresh;
  const editable = scope?.owner && !blocked;
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">COMPANY POLICY · ASIA/KARACHI</span>
          <h1>Leave policies</h1>
          <p>
            Configure company-wide limits. Leave requests, reservations and
            salary deductions remain unavailable.
          </p>
        </div>
        <Link className="secondary-button" href="/organization">
          Company setup
        </Link>
      </section>
      <section className="settings-card timing-workspace leave-workspace">
        <button
          className="secondary-button"
          disabled={busy || view === 'loading'}
          onClick={() => void refresh()}
        >
          Refresh leave policies
        </button>
        {message && <p role="status">{message}</p>}
        {pending && (
          <div className="policy-preview">
            <p>
              Uncertain {pending.kind} request retained in memory. Refresh
              preserves its exact key and payload; new changes remain locked.
              Closing or reloading this tab loses the request; reconcile history
              before starting another change.
            </p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void command(pending)}
            >
              Retry exact leave request
            </button>
          </div>
        )}
        {view === 'loading' && <p role="status">Loading leave policies…</p>}
        {view === 'signed-out' && (
          <p>
            Sign in to view leave policies.{' '}
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
            Leave policy data is unavailable or invalid. Refresh to reload
            safely.
          </p>
        )}
        {view === 'ready' && scope && catalog && (
          <>
            <h2>{scope.company}</h2>
            <p>
              {scope.owner
                ? 'Owner · draft and publish access'
                : 'HR · read-only access'}
            </p>
            <section aria-label="Leave types">
              <h3>Company leave types</h3>
              {catalog.items.length === 0 && <p>No leave types configured.</p>}
              {catalog.items.map((t) => (
                <button
                  key={t.id}
                  className="secondary-button"
                  disabled={blocked}
                  onClick={() => void refresh(t.id, typeCursor.current, null)}
                >
                  View {t.code} policies
                </button>
              ))}
              <div className="employee-actions">
                <button
                  className="secondary-button"
                  disabled={blocked || typeCursor.current === null}
                  onClick={() =>
                    void refresh(typeRef.current, null, policyCursor.current)
                  }
                >
                  First leave types page
                </button>
                <button
                  className="secondary-button"
                  disabled={blocked || !catalog.nextCursor}
                  onClick={() =>
                    void refresh(
                      typeRef.current,
                      catalog.nextCursor,
                      policyCursor.current,
                    )
                  }
                >
                  Next leave types page
                </button>
              </div>
              {scope.owner && (
                <button
                  className="secondary-button"
                  disabled={blocked}
                  onClick={() => void refresh(null, typeCursor.current, null)}
                >
                  New leave type
                </button>
              )}
            </section>
            {history && (
              <section aria-label="Leave policy history">
                <h3>{history.leaveType.code} policy history</h3>
                <p>
                  As of {history.asOf} · latest published version{' '}
                  {history.latestPublishedVersion}
                </p>
                <p>
                  Configured limits are not current employee balances. Monthly
                  usage caps do not accrue or roll over.
                </p>
                {history.currentPolicy ? (
                  <div className="policy-preview">
                    <strong>
                      Current {history.currentPolicy.settings.name}
                    </strong>
                    <p>
                      {history.currentPolicy.settings.pay} · annual{' '}
                      {history.currentPolicy.settings.annualQuotaDays} days ·
                      monthly cap{' '}
                      {history.currentPolicy.settings.monthlyQuotaDays} days
                    </p>
                    <button
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => void inspect(history.currentPolicy!)}
                    >
                      Review current leave policy
                    </button>
                  </div>
                ) : (
                  <p>No applicable published leave policy.</p>
                )}
                {history.items.map((p) => (
                  <div className="document-summary" key={p.id}>
                    <div>
                      <strong>
                        Version {p.version} · {p.status}
                      </strong>
                      <small>
                        {p.settings.name} · from {p.effectiveFrom}
                        {p.effectiveUntil
                          ? ` until ${p.effectiveUntil} (exclusive)`
                          : ''}
                      </small>
                    </div>
                    <button
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => void inspect(p)}
                    >
                      Review leave version {p.version}
                    </button>
                  </div>
                ))}
                <div className="employee-actions">
                  <button
                    className="secondary-button"
                    disabled={blocked || policyCursor.current === null}
                    onClick={() =>
                      void refresh(
                        history.leaveType.id,
                        typeCursor.current,
                        null,
                      )
                    }
                  >
                    First leave policy page
                  </button>
                  <button
                    className="secondary-button"
                    disabled={blocked || !history.nextCursor}
                    onClick={() =>
                      void refresh(
                        history.leaveType.id,
                        typeCursor.current,
                        history.nextCursor,
                      )
                    }
                  >
                    Next leave policy page
                  </button>
                </div>
              </section>
            )}
            {review && (
              <section
                className="policy-preview"
                aria-label="Reviewed leave policy"
              >
                <h3>Review leave version {review.version}</h3>
                <dl>
                  <dt>Name</dt>
                  <dd>{review.settings.name}</dd>
                  <dt>Payment</dt>
                  <dd>{review.settings.pay}</dd>
                  <dt>Annual upfront quota</dt>
                  <dd>{review.settings.annualQuotaDays} days</dd>
                  <dt>Monthly usage cap</dt>
                  <dd>{review.settings.monthlyQuotaDays} days</dd>
                  <dt>Leave year starts</dt>
                  <dd>
                    Month {review.settings.leaveYearStart.month}, day{' '}
                    {review.settings.leaveYearStart.day}
                  </dd>
                  <dt>Rest days and holidays</dt>
                  <dd>{review.settings.nonWorkingDays}</dd>
                  <dt>Effective from</dt>
                  <dd>{review.effectiveFrom}</dd>
                  <dt>Review reason</dt>
                  <dd>{review.reason}</dd>
                </dl>
                {scope.owner && review.status === 'draft' && (
                  <form onSubmit={publish}>
                    <label>
                      Publication reason
                      <input
                        value={publicationReason}
                        disabled={blocked}
                        onChange={(e) => setPublicationReason(e.target.value)}
                        maxLength={240}
                        required
                        minLength={3}
                      />
                    </label>
                    <button
                      className="primary-button"
                      disabled={
                        blocked ||
                        review.basedOnVersion !==
                          history?.latestPublishedVersion ||
                        review.effectiveFrom < today()
                      }
                    >
                      Publish leave policy
                    </button>
                  </form>
                )}
              </section>
            )}
            {scope.owner && (
              <section>
                <h3>
                  {history
                    ? 'New leave policy draft'
                    : 'Create leave type and first draft'}
                </h3>
                <p>
                  No statutory quotas are supplied. Enter your reviewed company
                  rules. Published leave-year changes require reconciliation and
                  are currently refused.
                </p>
                <form className="settings-form" onSubmit={create}>
                  <label>
                    Leave type code
                    <input
                      value={history?.leaveType.code ?? values.code}
                      readOnly={!!history}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, code: e.target.value })
                      }
                      pattern="[A-Z][A-Z0-9_-]{0,31}"
                      maxLength={32}
                      required
                    />
                  </label>
                  <label>
                    Leave type name
                    <input
                      value={values.name}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, name: e.target.value })
                      }
                      maxLength={120}
                      required
                    />
                  </label>
                  <label>
                    Paid or unpaid
                    <select
                      value={values.pay}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, pay: e.target.value })
                      }
                      required
                    >
                      <option value="">Choose payment treatment</option>
                      <option value="paid">Paid</option>
                      <option value="unpaid">Unpaid</option>
                    </select>
                  </label>
                  <label>
                    Annual quota days
                    <input
                      type="number"
                      min={0}
                      max={366}
                      step={0.5}
                      value={values.annual}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, annual: e.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    Monthly cap days
                    <input
                      type="number"
                      min={0}
                      max={31}
                      step={0.5}
                      value={values.monthly}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, monthly: e.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    Leave year start month
                    <input
                      type="number"
                      min={1}
                      max={12}
                      step={1}
                      value={values.month}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, month: e.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    Leave year start day
                    <input
                      type="number"
                      min={1}
                      max={31}
                      step={1}
                      value={values.day}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, day: e.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    Rest days and holidays
                    <select
                      value={values.calendar}
                      disabled={!editable}
                      onChange={(e) =>
                        setValues({ ...values, calendar: e.target.value })
                      }
                      required
                    >
                      <option value="">Choose calendar treatment</option>
                      <option value="exclude">
                        Exclude from requested days
                      </option>
                      <option value="include">Include in requested days</option>
                    </select>
                  </label>
                  <label>
                    Effective from
                    <input
                      type="date"
                      value={effectiveFrom}
                      min={today()}
                      disabled={!editable}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Draft reason
                    <input
                      value={reason}
                      disabled={!editable}
                      onChange={(e) => setReason(e.target.value)}
                      required
                      minLength={3}
                      maxLength={240}
                    />
                  </label>
                  <p>
                    Supported grant mode: annual upfront. Monthly usage limit is
                    not monthly accrual.
                  </p>
                  <button className="primary-button" disabled={!editable}>
                    {history ? 'Create leave draft' : 'Create leave type'}
                  </button>
                </form>
              </section>
            )}
          </>
        )}
      </section>
    </>
  );
}
