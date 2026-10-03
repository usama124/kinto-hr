'use client';

import { useState, type FormEvent } from 'react';
import {
  employeeBankDetailsResponseSchema,
  employeeBankDetailsUpdateSchema,
  type EmployeeBankDetailsResponse,
} from '@kinto/contracts';

export default function EmployeeBankDetails({
  tenantId,
  employeeId,
  csrf,
  canWrite,
  editable,
}: {
  tenantId: string;
  employeeId: string;
  csrf: string;
  canWrite: boolean;
  editable: boolean;
}) {
  const [record, setRecord] = useState<EmployeeBankDetailsResponse | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const url = `/api/v1/tenants/${tenantId}/employees/${employeeId}/bank-details`;
  async function load() {
    setBusy(true);
    setMessage('');
    // Discard previously loaded values if permissions have changed or refresh fails.
    setRecord(null);
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error();
      setRecord(employeeBankDetailsResponseSchema.parse(await response.json()));
    } catch {
      setMessage(
        'Bank details could not be loaded. Check payroll access and recent MFA.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('bankReason'));
    const clear = reason === 'clear_details';
    const input = employeeBankDetailsUpdateSchema.safeParse({
      expectedVersion: record?.details?.version ?? 0,
      bankName: clear ? null : String(form.get('bankName') || ''),
      accountTitle: clear ? null : String(form.get('accountTitle') || ''),
      accountNumber: clear ? null : String(form.get('accountNumber') || ''),
      reason,
    });
    if (!input.success)
      return setMessage(
        'Supply all bank fields, or choose Clear saved details for an existing record.',
      );
    if (
      clear &&
      !window.confirm(
        'Clear the saved bank details? This does not change salary or make a payment.',
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(input.data),
      });
      if (response.status === 409) {
        setRecord(null);
        return setMessage(
          'Bank details changed elsewhere. Reload the current version before retrying.',
        );
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setRecord(null);
        throw new Error();
      }
      await load();
      // load owns its own diagnostics; do not claim capture if refresh fails.
    } catch {
      setMessage(
        'Bank details were not confirmed saved. Reload before retrying; payroll access and recent MFA are required.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="employee-bank-details"
      aria-label="Restricted employee bank details"
    >
      <p className="employee-schedule">
        Restricted bank details · external salary payments only
      </p>
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={() => void load()}
      >
        {record ? 'Reload bank details' : 'Load bank details'}
      </button>
      {message && <p role="status">{message}</p>}
      {record && (
        <>
          {!record.details && <p>No bank details recorded.</p>}
          {canWrite && editable ? (
            <form
              key={record.details?.version ?? 0}
              onSubmit={(event) => void save(event)}
              className="employee-activation"
            >
              <label>
                Bank name
                <input
                  name="bankName"
                  maxLength={120}
                  autoComplete="off"
                  defaultValue={record.details?.bankName ?? ''}
                />
              </label>
              <label>
                Account title
                <input
                  name="accountTitle"
                  maxLength={160}
                  autoComplete="off"
                  defaultValue={record.details?.accountTitle ?? ''}
                />
              </label>
              <label>
                Account number or IBAN
                <input
                  name="accountNumber"
                  maxLength={50}
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={record.details?.accountNumber ?? ''}
                />
              </label>
              <p>
                Letters and digits only; spaces are removed and leading zeroes
                preserved. No account ownership or IBAN checksum verification.
              </p>
              <label>
                Bank change reason
                <select
                  name="bankReason"
                  defaultValue={
                    record.details ? 'account_change' : 'initial_setup'
                  }
                >
                  <option value="initial_setup">Initial setup</option>
                  <option value="account_change">Account change</option>
                  <option value="details_correction">Details correction</option>
                  {record.details && (
                    <option value="clear_details">Clear saved details</option>
                  )}
                </select>
              </label>
              <button disabled={busy} className="secondary-button">
                Save bank details
              </button>
            </form>
          ) : (
            record.details && (
              <dl>
                <dt>Bank name</dt>
                <dd>{record.details.bankName ?? 'Not recorded'}</dd>
                <dt>Account title</dt>
                <dd>{record.details.accountTitle ?? 'Not recorded'}</dd>
                <dt>Account number or IBAN</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>
                  {record.details.accountNumber ?? 'Not recorded'}
                </dd>
              </dl>
            )
          )}
        </>
      )}
    </section>
  );
}
