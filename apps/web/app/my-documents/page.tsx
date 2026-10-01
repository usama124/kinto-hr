'use client';

import { useEffect, useState } from 'react';
import {
  employeeDocumentListSchema,
  type EmployeeDocument,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function MyDocuments() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const options = {
          cache: 'no-store' as const,
          signal: controller.signal,
        };
        const response = await fetch('/api/v1/auth/session', options);
        if (response.status === 401 || response.status === 404)
          return setState('signed-out');
        if (!response.ok) throw new Error('Unavailable');
        const session: unknown = await response.json();
        if (
          !session ||
          typeof session !== 'object' ||
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
        if (!(tenant.roles as unknown[]).includes('employee'))
          return setState('denied');
        const result = await fetch(
          `/api/v1/tenants/${session.selectedTenantId}/me/documents`,
          options,
        );
        if (result.status === 401) return setState('signed-out');
        if (result.status === 403) return setState('denied');
        if (!result.ok) throw new Error('Unavailable');
        const parsed = employeeDocumentListSchema.parse(await result.json());
        // The server determines identity, expiry and replacement authority. Never
        // request an employee ID or expose non-clean/non-shared metadata here.
        if (
          parsed.documents.some(
            (document) =>
              document.status !== 'clean' ||
              document.visibility !== 'employee_visible',
          )
        )
          throw new Error('Invalid projection');
        setDocuments(parsed.documents);
        setTenantId(session.selectedTenantId);
        setCompanyName(tenant.name as string);
        setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function download(documentId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/me/documents/${documentId}/content`,
        { cache: 'no-store' },
      );
      if (response.status === 401 || response.status === 403) {
        setDocuments([]);
        return setState(response.status === 401 ? 'signed-out' : 'denied');
      }
      if (!response.ok) throw new Error('Unavailable');
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `document-${documentId}`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Authorized document download started.');
    } catch {
      setMessage(
        'This document is no longer available or storage is unavailable. Refresh to check your shared documents.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (state !== 'ready')
    return (
      <p className="notice">
        {
          {
            loading: 'Loading your documents…',
            'select-company':
              'Choose a company workspace to view your documents.',
            'signed-out': 'Sign in to view your documents.',
            denied:
              'Employee document access is unavailable. Contact HR or sign in again if verification is required.',
            error: 'Your documents are unavailable. Refresh and try again.',
          }[state]
        }
      </p>
    );

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EMPLOYEE SELF-SERVICE</p>
          <h1>My documents</h1>
          <p className="subtitle">
            {companyName} · Documents HR has shared with you.
          </p>
        </div>
      </div>
      <section className="settings-card" aria-label="Shared documents">
        <h2>Shared documents</h2>
        <p>
          Only your clean, unexpired documents shared by HR appear here. Each
          download checks your current access again. Contact HR to request a
          correction or replacement.
        </p>
        {message && <p role="status">{message}</p>}
        {documents.length === 0 ? (
          <p>No documents have been shared with you.</p>
        ) : (
          <ul className="document-list">
            {documents.map((document) => (
              <li key={document.id}>
                <div className="document-summary">
                  <strong>{document.fileName}</strong>
                  <span>
                    {document.category} · {Math.ceil(document.sizeBytes / 1024)}{' '}
                    KB
                  </span>
                  <span>
                    {document.expiresOn
                      ? `Expires ${document.expiresOn}`
                      : 'No expiry date'}
                  </span>
                </div>
                <div className="document-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void download(document.id)}
                    aria-label={`Download ${document.fileName}`}
                  >
                    Download
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
