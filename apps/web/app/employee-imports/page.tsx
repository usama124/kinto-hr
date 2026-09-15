'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  employeeImportHeaders,
  employeeImportPreviewSchema,
  type EmployeeImportPreview,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function EmployeeImports() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [requestKey, setRequestKey] = useState('');
  const [reason, setReason] = useState('');
  const [confirmationReason, setConfirmationReason] = useState('');
  const [confirmationKey, setConfirmationKey] = useState('');
  const [preview, setPreview] = useState<EmployeeImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/session', {
          cache: 'no-store',
        });
        if (response.status === 401 || response.status === 404)
          return setState('signed-out');
        if (!response.ok) throw new Error('Unavailable');
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== 'object' ||
          !('selectedTenantId' in data) ||
          !('csrfToken' in data) ||
          typeof data.csrfToken !== 'string' ||
          !('tenants' in data) ||
          !Array.isArray(data.tenants)
        )
          throw new Error('Invalid session');
        if (data.selectedTenantId === null) return setState('select-company');
        if (
          typeof data.selectedTenantId !== 'string' ||
          !uuid.test(data.selectedTenantId)
        )
          throw new Error('Invalid tenant');
        const tenant = data.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === data.selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string',
        );
        if (!tenant || !('name' in tenant)) throw new Error('Invalid company');
        setTenantId(data.selectedTenantId);
        setCsrf(data.csrfToken);
        setCompanyName(String(tenant.name));
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  function downloadTemplate() {
    const sample = `${employeeImportHeaders.join(',')}\nEMP-001,Sana Khan,,2026-09-14,LHR-01,ENG,SWE,,Company leader\n`;
    const url = URL.createObjectURL(new Blob([sample], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'kinto-employee-import-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !requestKey) return;
    setBusy(true);
    setMessage('');
    try {
      if (file.size > 65_536) throw new Error('Too large');
      const content = await file.text();
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employee-imports`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify({ fileName: file.name, content, reason }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      const result = employeeImportPreviewSchema.parse(await response.json());
      setPreview(result);
      setConfirmationKey(crypto.randomUUID());
      setMessage(
        result.status === 'ready'
          ? 'Preview is valid. No employee records have been created.'
          : 'Preview contains errors. Correct the CSV and upload it again.',
      );
    } catch {
      setMessage(
        'The CSV could not be previewed. Use the template and a file no larger than 64 KiB.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || preview.status !== 'ready' || !confirmationKey) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employee-imports/${preview.id}/confirm`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': confirmationKey,
          },
          body: JSON.stringify({
            previewRevision: preview.previewRevision,
            fileDigest: preview.fileDigest,
            reason: confirmationReason,
          }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      const result = employeeImportPreviewSchema.parse(await response.json());
      setPreview(result);
      if (result.status === 'committed')
        setMessage(
          `${result.employees.length} employees were created and activated atomically.`,
        );
      else {
        setConfirmationKey('');
        setMessage(
          'Confirmation found changed references or duplicate employees. Upload a corrected CSV for a new preview.',
        );
      }
    } catch {
      setMessage(
        'The import could not be confirmed. Check capacity and refresh the preview before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (state !== 'ready') {
    const copy = {
      loading: 'Loading employee imports…',
      'select-company':
        'Choose a company workspace before importing employees.',
      'signed-out': 'Sign in to preview an employee import.',
      denied: 'Your account cannot access employee imports.',
      error: 'Employee imports are unavailable. Refresh and try again.',
      ready: '',
    }[state];
    return <p className="notice">{copy}</p>;
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EMPLOYEE IMPORTS</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Validate a fixed CSV template before any employee records are
            created.
          </p>
        </div>
      </div>
      <div className="people-grid">
        <section className="settings-card">
          <div className="section-heading">
            <h2>Upload CSV</h2>
            <span>Preview only</span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={downloadTemplate}
          >
            Download CSV template
          </button>
          <form className="settings-form" onSubmit={upload}>
            <label>
              Employee CSV
              <input
                type="file"
                accept=".csv,text/csv"
                required
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setRequestKey(crypto.randomUUID());
                  setPreview(null);
                  setMessage('');
                  setConfirmationKey('');
                  setConfirmationReason('');
                }}
              />
            </label>
            <label>
              Preview reason
              <input
                required
                minLength={3}
                maxLength={240}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy || !file || !requestKey}
            >
              {busy ? 'Validating…' : 'Upload and validate'}
            </button>
          </form>
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
        </section>
        <section className="settings-card" aria-labelledby="preview-heading">
          <div className="section-heading">
            <h2 id="preview-heading">Validation preview</h2>
            <span>
              {preview ? `${preview.errorCount} errors` : 'No upload'}
            </span>
          </div>
          {!preview ? (
            <p className="empty-state">Upload a CSV to see row results.</p>
          ) : (
            <>
              <p>
                <strong>{preview.fileName}</strong> · {preview.rowCount} rows ·
                revision {preview.previewRevision}
              </p>
              <p className="employee-schedule">
                SHA-256: <code>{preview.fileDigest}</code>
              </p>
              {preview.fileErrors.map((error, index) => (
                <p key={`${error.field}-${index}`} className="notice">
                  File: {error.field} · {error.code}
                </p>
              ))}
              <ol className="employee-list">
                {preview.rows.map((row) => (
                  <li key={row.rowNumber} className="employee-row">
                    <div className="employee-summary">
                      <div>
                        <strong>
                          Row {row.rowNumber} ·{' '}
                          {row.values.employeeNumber ?? 'Invalid number'}
                        </strong>
                        <small>{row.values.name ?? 'Invalid name'}</small>
                      </div>
                      <span className="preview-badge">
                        {row.errors.length ? 'invalid' : 'valid'}
                      </span>
                    </div>
                    {row.errors.map((error, index) => (
                      <p key={`${error.field}-${index}`}>
                        {error.field}: {error.code}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
              {preview.status === 'ready' && (
                <form className="settings-form" onSubmit={confirm}>
                  <label>
                    Confirmation reason
                    <input
                      required
                      minLength={3}
                      maxLength={240}
                      value={confirmationReason}
                      onChange={(event) =>
                        setConfirmationReason(event.target.value)
                      }
                    />
                  </label>
                  <button
                    className="primary-button"
                    disabled={busy || !confirmationKey}
                  >
                    {busy
                      ? 'Committing…'
                      : `Create ${preview.rowCount} employees`}
                  </button>
                </form>
              )}
              {preview.status === 'committed' && (
                <div className="notice" role="status">
                  <strong>Import committed</strong>
                  <p>
                    {preview.employees.length} active employees were created.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <p className="audit-note">
        Kinto stores the normalized preview, digest, row errors and audit
        reason. The uploaded CSV content is not retained. Confirmation locks
        tenant capacity and creates the whole validated batch atomically.
      </p>
    </>
  );
}
