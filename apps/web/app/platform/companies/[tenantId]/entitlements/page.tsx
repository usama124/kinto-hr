'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  entitlementChangeSchema,
  entitlementPreviewSchema,
  entitlementChangeResultSchema,
  platformEntitlementStateSchema,
  tenantIdSchema,
  type EntitlementChange,
  type PlatformEntitlementState,
} from '@kinto/contracts';
type View =
  'loading' | 'ready' | 'signed-out' | 'denied' | 'unavailable' | 'error';
type Approval = {
  tenantId: string;
  requestId: string;
  input: EntitlementChange;
  preview: ReturnType<typeof entitlementPreviewSchema.parse>;
};
type RevocationAttempt = {
  tenantId: string;
  requestId: string;
  control: PlatformEntitlementState['controls'][number];
  reason: string;
};
export default function EntitlementControls() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const activeTenant = useRef(tenantId);
  activeTenant.current = tenantId;
  const [view, setView] = useState<View>('loading');
  const [csrf, setCsrf] = useState('');
  const [state, setState] = useState<PlatformEntitlementState | null>(null);
  const [kind, setKind] =
    useState<EntitlementChange['changeType']>('capacity_addon');
  const [amount, setAmount] = useState('5');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState<Approval | null>(null);
  const [pending, setPending] = useState<Approval | null>(null);
  const [pendingRevocation, setPendingRevocation] =
    useState<RevocationAttempt | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState('');
  const base = `/api/v1/platform/tenants/${tenantId}`;
  function denied(status: number) {
    if (![401, 403, 404].includes(status)) return false;
    setState(null);
    setPending(null);
    setPendingRevocation(null);
    setApproval(null);
    setView(
      status === 401 ? 'signed-out' : status === 403 ? 'denied' : 'unavailable',
    );
    return true;
  }
  async function load(signal?: AbortSignal) {
    const response = await fetch(`${base}/entitlements`, {
      cache: 'no-store',
      signal,
    });
    if (activeTenant.current !== tenantId) return false;
    if (denied(response.status)) return false;
    if (!response.ok) throw new Error('Unavailable');
    const parsed = platformEntitlementStateSchema.parse(await response.json());
    if (activeTenant.current !== tenantId) return false;
    if (parsed.tenantId !== tenantId) throw new Error('Wrong company');
    setState(parsed);
    setView('ready');
    return true;
  }
  useEffect(() => {
    const controller = new AbortController();
    setBusy(false);
    setView('loading');
    setState(null);
    setPending(null);
    setPendingRevocation(null);
    setApproval(null);
    setReasons({});
    setMessage('');
    setBlocked(false);
    setKind('capacity_addon');
    setAmount('5');
    setStartsAt('');
    setEndsAt('');
    setReason('');
    void (async () => {
      try {
        tenantIdSchema.parse(tenantId);
        const response = await fetch('/api/v1/auth/session', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 404)
          return setView('signed-out');
        if (!response.ok) throw new Error('Unavailable');
        const session: unknown = await response.json();
        if (
          !session ||
          typeof session !== 'object' ||
          !('csrfToken' in session) ||
          typeof session.csrfToken !== 'string'
        )
          throw new Error('Invalid session');
        if (controller.signal.aborted) return;
        setCsrf(session.csrfToken);
        await load(controller.signal);
      } catch {
        if (!controller.signal.aborted) setView('error');
      }
    })();
    return () => controller.abort();
    // The route identifies the company independently of customer selection.
  }, [tenantId]);
  async function preview(event: FormEvent) {
    event.preventDefault();
    setApproval(null);
    setMessage('');
    const input = entitlementChangeSchema.safeParse({
      changeType: kind,
      ...(kind === 'capacity_addon'
        ? { seatDelta: Number(amount) }
        : { employeeLimit: Number(amount) }),
      startsAt,
      endsAt,
      reason,
    });
    if (!input.success) {
      setMessage(
        'Provide valid capacity, ISO timestamps with timezone, an end after the start, and a reason of 3–240 characters.',
      );
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${base}/entitlement-changes/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(input.data),
      });
      if (activeTenant.current !== tenantId) return;
      if (denied(response.status)) return;
      if (!response.ok) throw new Error('Refused');
      const projected = entitlementPreviewSchema.parse(await response.json());
      if (activeTenant.current !== tenantId) return;
      setApproval({
        tenantId,
        requestId: crypto.randomUUID(),
        input: input.data,
        preview: projected,
      });
    } catch {
      if (activeTenant.current !== tenantId) return;
      setMessage('Preview unavailable or refused. No change was applied.');
    } finally {
      if (activeTenant.current === tenantId) setBusy(false);
    }
  }
  async function mutate(
    control?: PlatformEntitlementState['controls'][number],
    retry = false,
  ) {
    if (activeTenant.current !== tenantId) return;
    if (retry && pendingRevocation) {
      if (pendingRevocation.tenantId !== tenantId) return;
      control = pendingRevocation.control;
    }
    const creation = retry ? pending : approval;
    if (busy || (blocked && !retry) || (!control && !creation)) return;
    if (!control) {
      if (creation!.tenantId !== tenantId) return;
      setPending(creation);
    }
    const revokeReason = control
      ? retry
        ? pendingRevocation?.reason
        : reasons[control.id]?.trim()
      : '';
    if (
      control &&
      (!revokeReason || revokeReason.length < 3 || revokeReason.length > 240)
    )
      return;
    if (
      control &&
      !retry &&
      !window.confirm(
        'Revoke this control? Effective capacity or complimentary access may change.',
      )
    )
      return;
    const requestId = control
      ? retry
        ? pendingRevocation!.requestId
        : crypto.randomUUID()
      : creation!.requestId;
    if (control)
      setPendingRevocation({
        tenantId,
        requestId,
        control,
        reason: revokeReason!,
      });
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        control
          ? `${base}/entitlement-changes/${control.kind}/${control.id}/revocation`
          : `${base}/entitlement-changes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': requestId,
          },
          body: JSON.stringify(
            control
              ? { expectedVersion: control.version, reason: revokeReason }
              : creation!.input,
          ),
        },
      );
      if (activeTenant.current !== tenantId) return;
      if (denied(response.status)) return;
      if (response.status === 400 || response.status === 409) {
        setPending(null);
        setPendingRevocation(null);
        setBlocked(false);
        setApproval(null);
        if (await load())
          setMessage(
            'Change refused or stale. Review refreshed controls and preview again; overlapping overrides are not allowed.',
          );
        return;
      }
      if (!response.ok) throw new Error('Uncertain');
      entitlementChangeResultSchema.parse(await response.json());
      if (activeTenant.current !== tenantId) return;
      setPending(null);
      setPendingRevocation(null);
      setBlocked(false);
      setApproval(null);
      setReasons({});
      if (await load())
        setMessage(
          control
            ? retry
              ? 'Revocation receipt confirmed. Review current history for effective status.'
              : 'Control revoked with audit evidence.'
            : retry
              ? 'Creation receipt confirmed. Review current history for effective or revoked status.'
              : 'Entitlement control created with audit evidence.',
        );
    } catch {
      if (activeTenant.current !== tenantId) return;
      setApproval(null);
      setBlocked(true);
      setMessage(
        'Outcome could not be confirmed. Further mutations are blocked. Retry the retained exact request to reconcile safely. Keep this page open: reloading loses its request ID. Refreshing history does not replace the retained request.',
      );
    } finally {
      if (activeTenant.current === tenantId) setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setApproval(null);
    try {
      await load();
    } catch {
      if (activeTenant.current !== tenantId) return;
      setState(null);
      setView('error');
    } finally {
      if (activeTenant.current === tenantId) setBusy(false);
    }
  }
  const reconciliation = (
    <>
      {blocked && pendingRevocation?.tenantId === tenantId && (
        <div className="notice">
          <p>
            Unconfirmed revocation request: {pendingRevocation.requestId}. Exact
            retry keeps control {pendingRevocation.control.id}, expected version{' '}
            {pendingRevocation.control.version} and the original reason. A
            receipt confirms the original revocation without changing later
            controls.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate(undefined, true)}
          >
            Retry exact revocation request
          </button>
        </div>
      )}
      {blocked && pending?.tenantId === tenantId && (
        <div className="notice">
          <p>
            Unconfirmed creation request: {pending.requestId}. Retry returns the
            original creation receipt if already committed; it does not restore
            a revoked control.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate(undefined, true)}
          >
            Retry exact creation request
          </button>
        </div>
      )}
    </>
  );
  if (view !== 'ready' || !state || state.tenantId !== tenantId)
    return (
      <>
        <p className="notice">
          {
            {
              loading: 'Loading operator entitlement controls…',
              ready: '',
              'signed-out': 'Sign in to manage company entitlements.',
              denied:
                'Only an active platform operator with recent verification can manage entitlements.',
              unavailable:
                'An active company with a current subscription is required.',
              error:
                'Entitlement controls are unavailable. Refresh and try again.',
            }[view]
          }
        </p>
        {view === 'error' && reconciliation}
        {view === 'error' && message && <p role="status">{message}</p>}
      </>
    );
  return (
    <>
      {reconciliation}
      <div className="page-heading">
        <div>
          <p className="eyebrow">OPERATOR ENTITLEMENTS</p>
          <h1>{state.companyName}</h1>
          <p className="subtitle">
            Effective capacity and dated controls. No invoice or payment
            processing.
          </p>
        </div>
      </div>
      <section className="settings-card">
        <h2>Effective access</h2>
        <p>
          Evaluated {state.evaluatedAt}. Version{' '}
          {state.effective.entitlementVersion}.
        </p>
        <p>
          Employee limit: {state.effective.employeeLimit} · Active employees:{' '}
          {state.effective.activeEmployees} · Available seats:{' '}
          {state.effective.availableEmployeeSeats}
        </p>
        <p>Billing mode: {state.effective.billingMode.replaceAll('_', ' ')}</p>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh entitlement history
        </button>
        {message && <p role="status">{message}</p>}
      </section>
      <section className="settings-card">
        <h2>New dated control</h2>
        <p>
          Use ISO timestamps with timezone, for example
          2026-10-01T09:00:00+05:00. Preview evaluates at the start time; it is
          not a reservation or a guarantee of unchanged state at creation.
        </p>
        <form
          className="settings-form"
          onSubmit={(event) => void preview(event)}
        >
          <fieldset disabled={busy || blocked}>
            <legend>Control details</legend>
            <label>
              Control type
              <select
                value={kind}
                onChange={(event) => {
                  setKind(
                    event.target.value as EntitlementChange['changeType'],
                  );
                  setAmount('5');
                  setApproval(null);
                }}
              >
                <option value="capacity_addon">Capacity add-on</option>
                <option value="complimentary">Complimentary package</option>
                <option value="employee_limit_override">
                  Employee limit override
                </option>
              </select>
            </label>
            <label>
              Capacity value
              <input
                type="number"
                min={kind === 'employee_limit_override' ? 0 : 1}
                max={250}
                required
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setApproval(null);
                }}
              />
            </label>
            <label>
              Starts at
              <input
                required
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value);
                  setApproval(null);
                }}
              />
            </label>
            <label>
              Ends at
              <input
                required
                value={endsAt}
                onChange={(event) => {
                  setEndsAt(event.target.value);
                  setApproval(null);
                }}
              />
            </label>
            <label>
              Control reason
              <input
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setApproval(null);
                }}
              />
            </label>
            <button type="submit" className="primary-button">
              Preview control
            </button>
          </fieldset>
        </form>
        {approval && (
          <div>
            <p>
              Preview at {approval.preview.at}: capacity{' '}
              {approval.preview.before.employeeLimit} →{' '}
              {approval.preview.after.employeeLimit}; billing{' '}
              {approval.preview.before.billingMode} →{' '}
              {approval.preview.after.billingMode}.
            </p>
            <button
              type="button"
              className="primary-button"
              disabled={busy || blocked}
              onClick={() => void mutate()}
            >
              Apply previewed control
            </button>
          </div>
        )}
      </section>
      <section className="settings-card" aria-label="Entitlement history">
        <h2>Recent control history</h2>
        {state.historyTruncated && (
          <p>
            Only the latest 100 controls are shown. Use operator records for
            older history.
          </p>
        )}
        {state.controls.length === 0 ? (
          <p>No entitlement controls recorded.</p>
        ) : (
          <ul className="document-list">
            {state.controls.map((control) => (
              <li key={control.id}>
                <strong>
                  {control.changeType.replaceAll('_', ' ')} ·{' '}
                  {control.seatDelta ?? control.employeeLimit}
                </strong>
                <small>
                  {control.id} · version {control.version} ·{' '}
                  {control.status === 'revoked'
                    ? 'revoked'
                    : Date.parse(control.endsAt) <=
                        Date.parse(state.evaluatedAt)
                      ? 'expired'
                      : Date.parse(control.startsAt) >
                          Date.parse(state.evaluatedAt)
                        ? 'scheduled'
                        : 'effective'}
                </small>
                <p>
                  {control.startsAt} to {control.endsAt}
                </p>
                <p>{control.reason}</p>
                {control.revokedReason && (
                  <p>Revocation: {control.revokedReason}</p>
                )}
                {control.status === 'active' && (
                  <div className="document-actions">
                    <label>
                      Revocation reason
                      <input
                        aria-label={`Revocation reason ${control.id}`}
                        maxLength={240}
                        value={reasons[control.id] ?? ''}
                        disabled={busy || blocked}
                        onChange={(event) =>
                          setReasons((current) => ({
                            ...current,
                            [control.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Revoke control ${control.id}`}
                      disabled={
                        busy ||
                        blocked ||
                        (reasons[control.id]?.trim().length ?? 0) < 3
                      }
                      onClick={() => void mutate(control)}
                    >
                      Revoke control
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
