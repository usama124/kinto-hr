'use client';
import { FormEvent, useState } from 'react';
import {
  employeeAccountProvisioningSchema,
  employeeAccountProvisioningResultSchema,
  type EmployeeAccountProvisioning,
  type EmployeeAccountProvisioningResult,
} from '@kinto/contracts';
type Attempt = { key: string; input: EmployeeAccountProvisioning };
export default function EmployeeAccountInvitation({
  tenantId,
  employeeId,
  employeeName,
  csrf,
  disabled,
  onAccessDenied,
  onBusyChange,
  onRefresh,
}: {
  tenantId: string;
  employeeId: string;
  employeeName: string;
  csrf: string;
  disabled: boolean;
  onAccessDenied: (status: 401 | 403) => void;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null);
  const [result, setResult] =
    useState<EmployeeAccountProvisioningResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function send(attempt: Attempt) {
    if (busy || disabled) return;
    setBusy(true);
    onBusyChange(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/account-invitations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': attempt.key,
          },
          body: JSON.stringify(attempt.input),
        },
      );
      if (response.status === 401 || response.status === 403) {
        setPending(null);
        setResult(null);
        return onAccessDenied(response.status);
      }
      if ([400, 404, 409].includes(response.status)) {
        setPending(null);
        setResult(null);
        setMessage(
          response.status === 404
            ? 'Employee is unavailable for account setup. Refresh employee access before trying again.'
            : 'Account setup refused. Review the email and current employee access; existing or conflicting access may prevent a new request.',
        );
        return;
      }
      if (!response.ok) throw new Error('Unconfirmed');
      const accepted = employeeAccountProvisioningResultSchema.parse(
        await response.json(),
      );
      setResult(accepted);
      if (
        accepted.status === 'pending_identity_provider' ||
        accepted.status === 'pending_delivery'
      ) {
        setMessage(
          accepted.status === 'pending_delivery'
            ? 'Delivery is pending. No access is granted by this request; retry the exact request when delivery is available.'
            : 'Request recorded. Provider setup is disabled or unavailable. No access is granted by this request; retry the exact request when setup is available.',
        );
      } else {
        setPending(null);
        setMessage(
          {
            pending_activation:
              'Setup delivery recorded. Employee access remains pending until the exact invited identity completes verified activation.',
            active:
              'This request is already activated. Refresh employee access to review current login status.',
            failed:
              'This request is marked failed. Contact the operator; submitting again does not repair it.',
            revoked: 'This request is revoked. It cannot restore login access.',
          }[accepted.status],
        );
      }
    } catch {
      setMessage(
        'Account setup outcome could not be confirmed. Retry the same request; its email and key are retained in page memory. Keep this page open until the request is reconciled.',
      );
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || result || busy || disabled) return;
    const input = employeeAccountProvisioningSchema.safeParse({ email });
    if (!input.success)
      return setMessage('Enter a valid employee email address.');
    const attempt = { key: crypto.randomUUID(), input: input.data };
    setPending(attempt);
    void send(attempt);
  }
  if (!open)
    return (
      <button
        type="button"
        className="secondary-button"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Set up employee login for {employeeName}
      </button>
    );
  return (
    <section
      className="settings-card employee-account-setup"
      aria-label={`Employee login setup for ${employeeName}`}
    >
      <h3>Employee login setup</h3>
      <p>
        Only company owners and authorized HR can provision this employee. The
        role is fixed to Employee; administrator roles cannot be selected. This
        records a setup request, not immediate access. Existing users reset
        passwords through the identity provider. No self-signup is available.
      </p>
      <p>
        Exact retries retain the email and key in memory only. Closing or
        refreshing this page loses them; ask the operator to reconcile an
        unresolved request before submitting another one.
      </p>
      {message && <p role="status">{message}</p>}
      {result && (
        <p>
          Request {result.accountRequestId} ·{' '}
          {result.status.replaceAll('_', ' ')}
          {result.replayed ? ' · Existing request replayed' : ''}
        </p>
      )}
      {(!result || pending) && (
        <form className="settings-form" onSubmit={submit}>
          <label>
            Employee login email for {employeeName}
            <input
              type="email"
              required
              maxLength={320}
              value={email}
              disabled={disabled || busy || pending !== null}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {pending ? (
            <button
              className="primary-button"
              type="button"
              disabled={disabled || busy}
              onClick={() => void send(pending)}
            >
              Retry exact employee setup
            </button>
          ) : (
            <button
              className="primary-button"
              type="submit"
              disabled={disabled || busy}
            >
              Send employee setup
            </button>
          )}
        </form>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || busy}
        onClick={() => void onRefresh()}
      >
        Refresh employee access for {employeeName}
      </button>
    </section>
  );
}
