'use client';

import { FormEvent, useState } from 'react';
import {
  administratorInvitationSchema,
  administratorInvitationResultSchema,
  administrativeTenantRoleSchema,
  type AdministratorInvitation,
  type AdministratorInvitationResult,
} from '@kinto/contracts';

type PendingInvitation = { key: string; input: AdministratorInvitation };
type Role = (typeof administrativeTenantRoleSchema.options)[number];

export default function AdministratorInvitationForm({
  tenantId,
  csrf,
  disabled,
  onAccessDenied,
  onBusyChange,
}: {
  tenantId: string;
  csrf: string;
  disabled: boolean;
  onAccessDenied: (status: 401 | 403) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<PendingInvitation | null>(null);
  const [result, setResult] = useState<AdministratorInvitationResult | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function send(request: PendingInvitation) {
    setBusy(true);
    onBusyChange(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/administrator-invitations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': request.key,
          },
          body: JSON.stringify(request.input),
        },
      );
      if (response.status === 401 || response.status === 403)
        return onAccessDenied(response.status);
      if (response.status === 400 || response.status === 409) {
        setPending(null);
        setResult(null);
        setMessage(
          'Invitation refused. Check the email and roles; existing or overlapping access may prevent a new invitation.',
        );
        return;
      }
      if (!response.ok) throw new Error('Unconfirmed');
      const accepted = administratorInvitationResultSchema.parse(
        await response.json(),
      );
      setResult(accepted);
      if (
        accepted.status === 'pending_identity_provider' ||
        accepted.status === 'pending_delivery'
      ) {
        setMessage(
          accepted.status === 'pending_delivery'
            ? 'Delivery is pending. No access is granted; retry this same request when the provider is available.'
            : 'Request recorded. Provider setup is disabled or delivery is unavailable. No access is granted; retry this same request when the provider is available.',
        );
      } else {
        setPending(null);
        setMessage(
          {
            pending_activation:
              'Setup delivery recorded. Access stays pending until the exact invited identity completes verified activation.',
            active:
              'This invitation is already activated. Refresh memberships to review current access.',
            failed:
              'This request is marked failed. Contact the operator; no new access is granted by this result.',
            revoked: 'This request is revoked. It cannot restore access.',
          }[accepted.status],
        );
      }
    } catch {
      setMessage(
        'The invitation outcome could not be confirmed. Retry the same request; its email, roles and idempotency key are retained until this page is closed or refreshed.',
      );
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || busy || disabled) return;
    const parsed = administratorInvitationSchema.safeParse({
      email,
      roles,
      reason,
    });
    if (!parsed.success) {
      setMessage(
        'Enter a valid email, at least one administrative role and a reason of 3–240 characters.',
      );
      return;
    }
    const request = { key: crypto.randomUUID(), input: parsed.data };
    setPending(request);
    setResult(null);
    void send(request);
  }

  function startAnother() {
    setResult(null);
    setMessage('');
    setEmail('');
    setRoles([]);
    setReason('');
  }

  if (!open)
    return (
      <section className="settings-card">
        <h2>Invite an administrator</h2>
        <p>
          Only company owners can provision another owner, HR or payroll
          administrator. Employees are provisioned through employee records.
        </p>
        <button
          className="secondary-button"
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Invite administrator
        </button>
      </section>
    );

  return (
    <section className="settings-card" aria-label="Administrator invitation">
      <h2>Invite an administrator</h2>
      <p>
        Choose the approved administrative roles. This records a setup request,
        not immediate access. Provider-managed email, password and MFA setup
        must complete before activation. No public signup is available.
      </p>
      <p>
        Retries retain the exact request in page memory only. Refreshing or
        closing the page loses that retry key; ask the operator to reconcile an
        unresolved request before submitting a new one.
      </p>
      {message && <p role="status">{message}</p>}
      {result && (
        <p className="document-removal">
          Request {result.accountRequestId} ·{' '}
          {result.status.replaceAll('_', ' ')}
          {result.replayed ? ' · Existing request replayed' : ''}
        </p>
      )}
      {result && !pending ? (
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || busy}
          onClick={startAnother}
        >
          New invitation
        </button>
      ) : (
        <form className="settings-form" onSubmit={submit}>
          <label>
            Administrator email
            <input
              type="email"
              maxLength={320}
              required
              value={email}
              disabled={disabled || busy || pending !== null}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <fieldset
            className="membership-roles"
            disabled={disabled || busy || pending !== null}
          >
            <legend>Invitation roles</legend>
            {administrativeTenantRoleSchema.options.map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={(event) =>
                    setRoles((current) =>
                      event.target.checked
                        ? [...current, role]
                        : current.filter((value) => value !== role),
                    )
                  }
                />
                {role.replaceAll('_', ' ')}
              </label>
            ))}
          </fieldset>
          <label>
            Invitation reason
            <input
              minLength={3}
              maxLength={240}
              required
              value={reason}
              disabled={disabled || busy || pending !== null}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {pending ? (
            <button
              className="primary-button"
              type="button"
              disabled={disabled || busy}
              onClick={() => void send(pending)}
            >
              Retry same invitation
            </button>
          ) : (
            <button
              className="primary-button"
              type="submit"
              disabled={
                disabled ||
                busy ||
                roles.length === 0 ||
                reason.trim().length < 3
              }
            >
              Submit administrator invitation
            </button>
          )}
        </form>
      )}
    </section>
  );
}
