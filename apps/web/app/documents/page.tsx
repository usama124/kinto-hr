'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  employeeDocumentListSchema,
  employeeDocumentReplacementActivationResultSchema,
  employeeDocumentSchema,
  employeeRosterSchema,
  type EmployeeDocument,
  type EmployeeRecordView,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
type PendingUpload = { documentId: string; file: File };
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const categories = [
  'identity',
  'employment',
  'education',
  'medical',
  'tax',
  'bank',
  'other',
] as const;
const contentTypes = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const label = (value: string) =>
  value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
  }).format(new Date(value));

export default function DocumentManager() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [employees, setEmployees] = useState<EmployeeRecordView[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
  const [category, setCategory] =
    useState<(typeof categories)[number]>('employment');
  const [visibility, setVisibility] = useState<'hr_only' | 'employee_visible'>(
    'hr_only',
  );
  const [expiresOn, setExpiresOn] = useState('');
  const [replacementDocumentId, setReplacementDocumentId] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [requestKey, setRequestKey] = useState('');
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(
    null,
  );
  const [retryFiles, setRetryFiles] = useState<Record<string, File>>({});
  const [activationReasons, setActivationReasons] = useState<
    Record<string, string>
  >({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function loadDocuments(
    selectedTenantId: string,
    selectedEmployeeId: string,
  ) {
    const response = await fetch(
      `/api/v1/tenants/${selectedTenantId}/employees/${selectedEmployeeId}/documents`,
      { cache: 'no-store' },
    );
    if (response.status === 401) {
      setState('signed-out');
      return false;
    }
    if (response.status === 403) {
      setState('denied');
      return false;
    }
    if (!response.ok) throw new Error('Unavailable');
    const result = employeeDocumentListSchema.parse(await response.json());
    setDocuments(result.documents);
    return true;
  }

  useEffect(() => {
    void (async () => {
      try {
        const sessionResponse = await fetch('/api/v1/auth/session', {
          cache: 'no-store',
        });
        if (sessionResponse.status === 401 || sessionResponse.status === 404)
          return setState('signed-out');
        if (!sessionResponse.ok) throw new Error('Unavailable');
        const session: unknown = await sessionResponse.json();
        if (
          !session ||
          typeof session !== 'object' ||
          !('csrfToken' in session) ||
          typeof session.csrfToken !== 'string' ||
          !('selectedTenantId' in session) ||
          !('tenants' in session) ||
          !Array.isArray(session.tenants)
        )
          throw new Error('Invalid session');
        if (session.selectedTenantId === null)
          return setState('select-company');
        if (
          typeof session.selectedTenantId !== 'string' ||
          !uuid.test(session.selectedTenantId)
        )
          throw new Error('Invalid tenant');
        const tenant = session.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === session.selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string' &&
            'roles' in candidate &&
            Array.isArray(candidate.roles),
        );
        if (!tenant || !('name' in tenant) || !('roles' in tenant))
          throw new Error('Invalid company');
        if (
          !(tenant.roles as unknown[]).some(
            (role) => role === 'owner' || role === 'hr_admin',
          )
        )
          return setState('denied');

        const rosterResponse = await fetch(
          `/api/v1/tenants/${session.selectedTenantId}/employees`,
          { cache: 'no-store' },
        );
        if (rosterResponse.status === 401) return setState('signed-out');
        if (rosterResponse.status === 403) return setState('denied');
        if (!rosterResponse.ok) throw new Error('Unavailable');
        const roster = employeeRosterSchema.parse(await rosterResponse.json());
        setTenantId(session.selectedTenantId);
        setCsrf(session.csrfToken);
        setCompanyName(String(tenant.name));
        setEmployees(roster.employees);
        const firstEmployee = roster.employees[0]?.id ?? '';
        setEmployeeId(firstEmployee);
        if (firstEmployee) {
          const loaded = await loadDocuments(
            session.selectedTenantId,
            firstEmployee,
          );
          if (!loaded) return;
        }
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  async function chooseEmployee(nextEmployeeId: string) {
    setEmployeeId(nextEmployeeId);
    setDocuments([]);
    setPendingUpload(null);
    setMessage('');
    if (!nextEmployeeId) return;
    setBusy(true);
    try {
      await loadDocuments(tenantId, nextEmployeeId);
    } catch {
      setMessage('Documents could not be loaded for this employee.');
    } finally {
      setBusy(false);
    }
  }

  async function uploadRegistered(pending: PendingUpload) {
    const response = await fetch(
      `/api/v1/tenants/${tenantId}/employees/${employeeId}/documents/${pending.documentId}/content`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-CSRF-Token': csrf,
        },
        body: pending.file,
      },
    );
    if (response.status === 401) {
      setState('signed-out');
      return false;
    }
    if (response.status === 403) {
      setState('denied');
      return false;
    }
    if (!response.ok) throw new Error(String(response.status));
    employeeDocumentSchema.parse(await response.json());
    setPendingUpload(null);
    setFile(null);
    setFileInputKey((current) => current + 1);
    setRequestKey('');
    setReason('');
    setExpiresOn('');
    setReplacementDocumentId('');
    await loadDocuments(tenantId, employeeId);
    setMessage('Document uploaded, scanned, and recorded as clean.');
    return true;
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    if (!file || !employeeId || !requestKey) return;
    setBusy(true);
    setMessage('');
    try {
      if (
        file.size < 1 ||
        file.size > 10 * 1024 * 1024 ||
        !contentTypes.includes(file.type as (typeof contentTypes)[number])
      )
        throw new Error('Invalid file');
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/documents`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': requestKey,
          },
          body: JSON.stringify({
            category,
            visibility,
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
            fileDigest: digest,
            expiresOn: expiresOn || null,
            replacementDocumentId: replacementDocumentId || null,
            reason,
          }),
        },
      );
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Registration failed');
      const document = employeeDocumentSchema.parse(await response.json());
      const pending = { documentId: document.id, file };
      setPendingUpload(pending);
      await loadDocuments(tenantId, employeeId);
      try {
        await uploadRegistered(pending);
      } catch {
        setMessage(
          'Metadata was saved, but upload or malware scanning is unavailable. Retry the exact same file when local document services recover.',
        );
      }
    } catch {
      setMessage(
        'Document registration failed. Use a PDF, JPEG, or PNG no larger than 10 MB and check every field.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function retryUpload() {
    if (!pendingUpload) return;
    setBusy(true);
    setMessage('');
    try {
      await uploadRegistered(pendingUpload);
    } catch {
      setMessage(
        'Upload or malware scanning is still unavailable. The registered metadata remains pending.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadExisting(document: EmployeeDocument) {
    const retryFile = retryFiles[document.id];
    if (
      !retryFile ||
      retryFile.size !== document.sizeBytes ||
      retryFile.type !== document.contentType
    ) {
      setMessage('Choose the exact registered file type and byte length.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/documents/${document.id}/content`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-CSRF-Token': csrf,
          },
          body: retryFile,
        },
      );
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Upload failed');
      employeeDocumentSchema.parse(await response.json());
      setRetryFiles((current) => {
        const next = { ...current };
        delete next[document.id];
        return next;
      });
      await loadDocuments(tenantId, employeeId);
      setMessage('Document uploaded and malware scanning completed.');
    } catch {
      setMessage(
        'The exact file could not be uploaded or scanned. Its metadata remains pending.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function download(documentId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/documents/${documentId}/content`,
        { cache: 'no-store' },
      );
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Download failed');
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `document-${documentId}`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Authorized document download started.');
    } catch {
      setMessage('This document is not currently available for download.');
    } finally {
      setBusy(false);
    }
  }

  async function activateReplacement(documentId: string) {
    const activationReason = activationReasons[documentId]?.trim() ?? '';
    if (activationReason.length < 3) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/documents/${documentId}/replacement-activation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({ reason: activationReason }),
        },
      );
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Activation failed');
      employeeDocumentReplacementActivationResultSchema.parse(
        await response.json(),
      );
      setActivationReasons((current) => ({ ...current, [documentId]: '' }));
      await loadDocuments(tenantId, employeeId);
      setMessage('Replacement activated. The superseded document is retired.');
    } catch {
      setMessage(
        'Replacement activation failed. Both the candidate and its same-category target must be clean and current.',
      );
    } finally {
      setBusy(false);
    }
  }

  const authoritativeDocuments = documents.filter(
    (document) =>
      document.status === 'clean' &&
      (document.replacementDocumentId === null ||
        documents.some(
          (target) =>
            target.id === document.replacementDocumentId &&
            target.status === 'removed' &&
            target.removalReplacementDocumentId === document.id,
        )),
  );
  const selectedEmployee = employees.find(
    (employee) => employee.id === employeeId,
  );

  if (state !== 'ready') {
    const copy = {
      loading: 'Loading document manager…',
      'select-company': 'Choose a company workspace before managing documents.',
      'signed-out': 'Sign in to manage employee documents.',
      denied: 'Only company owners and HR administrators can manage documents.',
      error: 'Document management is unavailable. Refresh and try again.',
      ready: '',
    }[state];
    return <p className="notice">{copy}</p>;
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">DOCUMENT MANAGER</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Register, scan, review, replace, and retrieve private employee
            documents.
          </p>
        </div>
      </div>

      <section className="settings-card document-employee">
        <label>
          Employee
          <select
            aria-label="Employee"
            value={employeeId}
            disabled={busy || employees.length === 0}
            onChange={(event) => void chooseEmployee(event.target.value)}
          >
            {employees.length === 0 && <option value="">No employees</option>}
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNumber} · {employee.name}
              </option>
            ))}
          </select>
        </label>
        {selectedEmployee && (
          <span className="request-status">{selectedEmployee.status}</span>
        )}
      </section>

      <div className="document-grid">
        <section className="settings-card">
          <div className="section-heading">
            <h2>Register document</h2>
            <span>PDF, JPEG or PNG · 10 MB</span>
          </div>
          {!employeeId ? (
            <p className="empty-state">
              Create an employee before registering documents.
            </p>
          ) : (
            <form className="settings-form" onSubmit={register}>
              <label>
                File
                <input
                  key={fileInputKey}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  required
                  onChange={(event) => {
                    const next = event.target.files?.[0] ?? null;
                    setFile(next);
                    setRequestKey(next ? crypto.randomUUID() : '');
                    setPendingUpload(null);
                    setMessage('');
                  }}
                />
              </label>
              <div className="document-form-row">
                <label>
                  Category
                  <select
                    value={category}
                    onChange={(event) =>
                      setCategory(
                        event.target.value as (typeof categories)[number],
                      )
                    }
                  >
                    {categories.map((item) => (
                      <option key={item} value={item}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Visibility
                  <select
                    value={visibility}
                    onChange={(event) =>
                      setVisibility(
                        event.target.value as 'hr_only' | 'employee_visible',
                      )
                    }
                  >
                    <option value="hr_only">HR only</option>
                    <option value="employee_visible">Employee visible</option>
                  </select>
                </label>
              </div>
              <label>
                Expiry date (optional)
                <input
                  type="date"
                  value={expiresOn}
                  onChange={(event) => setExpiresOn(event.target.value)}
                />
              </label>
              <label>
                Replaces document (optional)
                <select
                  value={replacementDocumentId}
                  onChange={(event) =>
                    setReplacementDocumentId(event.target.value)
                  }
                >
                  <option value="">New document</option>
                  {authoritativeDocuments.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.fileName} · {label(document.category)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Registration reason
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
                {busy ? 'Registering and scanning…' : 'Register and upload'}
              </button>
              {pendingUpload && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void retryUpload()}
                >
                  Retry exact file upload
                </button>
              )}
            </form>
          )}
        </section>

        <section className="settings-card document-register-note">
          <div className="section-heading">
            <h2>Private by design</h2>
            <span>Controlled pipeline</span>
          </div>
          <p>
            Kinto calculates the digest in your browser, chooses the private
            storage key, and permits download only after a clean malware scan.
          </p>
          <p>
            Replacement candidates stay hidden until HR activates the verified
            version. Retired records and bytes are retained until an approved
            retention policy permits removal.
          </p>
          <p className="audit-note">
            Local development upload requires the private local document mode
            and a loopback ClamAV service. Production refuses local storage.
          </p>
        </section>
      </div>

      <section className="settings-card document-list-card">
        <div className="section-heading">
          <h2>Employee documents</h2>
          <span>{documents.length} records</span>
        </div>
        {documents.length === 0 ? (
          <p className="empty-state">
            No document metadata exists for this employee.
          </p>
        ) : (
          <ul className="document-list">
            {documents.map((document) => {
              const pendingReplacement =
                document.status === 'clean' &&
                document.replacementDocumentId !== null &&
                !authoritativeDocuments.some(
                  (candidate) => candidate.id === document.id,
                );
              return (
                <li key={document.id}>
                  <div className="document-summary">
                    <div>
                      <strong>{document.fileName}</strong>
                      <small>
                        {label(document.category)} ·{' '}
                        {document.visibility === 'hr_only'
                          ? 'HR only'
                          : 'Employee visible'}{' '}
                        · {Math.ceil(document.sizeBytes / 1024)} KiB
                      </small>
                    </div>
                    <span className={`request-status ${document.status}`}>
                      {pendingReplacement
                        ? 'Awaiting activation'
                        : label(document.status)}
                    </span>
                  </div>
                  <small>
                    Registered {formatDate(document.createdAt)}
                    {document.expiresOn
                      ? ` · expires ${formatDate(document.expiresOn)}`
                      : ''}
                  </small>
                  {document.status === 'removed' && (
                    <p className="document-removal">
                      Retired{' '}
                      {document.removedAt ? formatDate(document.removedAt) : ''}
                      {document.removalReason
                        ? ` · ${document.removalReason}`
                        : ''}
                    </p>
                  )}
                  <div className="document-actions">
                    {['awaiting_upload', 'quarantined'].includes(
                      document.status,
                    ) && (
                      <>
                        <label>
                          Exact registered file
                          <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                            onChange={(event) => {
                              const retryFile =
                                event.target.files?.[0] ?? undefined;
                              if (!retryFile) return;
                              setRetryFiles((current) => ({
                                ...current,
                                [document.id]: retryFile,
                              }));
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy || !retryFiles[document.id]}
                          onClick={() => void uploadExisting(document)}
                        >
                          Upload and scan
                        </button>
                      </>
                    )}
                    {authoritativeDocuments.some(
                      (candidate) => candidate.id === document.id,
                    ) && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void download(document.id)}
                      >
                        Download
                      </button>
                    )}
                    {pendingReplacement && (
                      <>
                        <label>
                          Activation reason
                          <input
                            minLength={3}
                            maxLength={240}
                            value={activationReasons[document.id] ?? ''}
                            onChange={(event) =>
                              setActivationReasons((current) => ({
                                ...current,
                                [document.id]: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={
                            busy ||
                            (activationReasons[document.id]?.trim().length ??
                              0) < 3
                          }
                          onClick={() => void activateReplacement(document.id)}
                        >
                          Activate replacement
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
      </section>
    </>
  );
}
