'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  workforceHeadcountQuerySchema,
  workforceHeadcountReportSchema,
  workforceReportExportCreateSchema,
  workforceReportExportViewSchema,
  type WorkforceHeadcountQuery,
  type WorkforceHeadcountReport,
  type WorkforceReportExportView,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function karachiToday() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function initialQuery(): WorkforceHeadcountQuery {
  const asOf = karachiToday();
  return { asOf, periodStart: `${asOf.slice(0, 7)}-01`, periodEnd: asOf };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function Reports() {
  const defaults = initialQuery();
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [asOf, setAsOf] = useState(defaults.asOf);
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [report, setReport] = useState<WorkforceHeadcountReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [exportReason, setExportReason] = useState('Monthly workforce review');
  const [exportKey, setExportKey] = useState('');
  const [exportArtifact, setExportArtifact] =
    useState<WorkforceReportExportView | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function fetchReport(
    selectedTenantId: string,
    query: WorkforceHeadcountQuery,
  ) {
    const response = await fetch(
      `/api/v1/tenants/${selectedTenantId}/reports/headcount?${new URLSearchParams(query)}`,
      { cache: 'no-store' },
    );
    if (response.status === 401) {
      setState('signed-out');
      return null;
    }
    if (response.status === 403) {
      setState('denied');
      return null;
    }
    if (!response.ok) throw new Error('Unavailable');
    return workforceHeadcountReportSchema.parse(await response.json());
  }

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
          !('csrfToken' in data) ||
          typeof data.csrfToken !== 'string' ||
          !('selectedTenantId' in data) ||
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
        const selectedTenantId = data.selectedTenantId;
        const tenant = data.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string' &&
            'roles' in candidate &&
            Array.isArray(candidate.roles),
        );
        if (!tenant || !('name' in tenant) || !('roles' in tenant))
          throw new Error('Invalid company');
        const roles = (tenant.roles as unknown[]).filter(
          (role: unknown): role is string => typeof role === 'string',
        );
        if (!roles.some((role) => ['owner', 'hr_admin'].includes(role)))
          return setState('denied');
        setTenantId(selectedTenantId);
        setCsrf(data.csrfToken);
        setCompanyName(String(tenant.name));
        const loaded = await fetchReport(selectedTenantId, defaults);
        if (!loaded) return;
        setReport(loaded);
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  useEffect(() => {
    if (state !== 'ready' || !tenantId || exportArtifact?.status !== 'pending')
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exportId = exportArtifact.id;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/v1/tenants/${tenantId}/exports/${exportId}`,
          { cache: 'no-store' },
        );
        if (stopped) return;
        if (response.status === 401) return setState('signed-out');
        if (response.status === 403) return setState('denied');
        if (!response.ok) throw new Error('Unavailable');
        const artifact = workforceReportExportViewSchema.parse(
          await response.json(),
        );
        if (stopped) return;
        setExportArtifact(artifact);
        if (artifact.status === 'ready')
          setMessage('Your aggregate CSV is ready to download.');
        else if (artifact.status === 'expired')
          setMessage(
            'This export expired. Create a fresh copy to download it.',
          );
        else timer = setTimeout(poll, 750);
      } catch {
        if (!stopped) {
          setMessage('Export status is temporarily unavailable. Retrying…');
          timer = setTimeout(poll, 1500);
        }
      }
    };
    timer = setTimeout(poll, 250);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [exportArtifact?.id, exportArtifact?.status, state, tenantId]);

  function updateDate(setter: (value: string) => void, value: string) {
    setter(value);
    setExportKey('');
    setExportArtifact(null);
    setMessage('');
  }

  async function submitReport(event: FormEvent) {
    event.preventDefault();
    const query = workforceHeadcountQuerySchema.safeParse({
      asOf,
      periodStart,
      periodEnd,
    });
    if (!query.success) {
      setMessage(
        'Use valid dates with the period start before the end and no more than 366 days apart.',
      );
      return;
    }
    setReportBusy(true);
    setMessage('');
    setExportKey('');
    setExportArtifact(null);
    try {
      const loaded = await fetchReport(tenantId, query.data);
      if (!loaded) return;
      setReport(loaded);
      setMessage('Workforce totals updated.');
    } catch {
      setMessage(
        'The report could not be loaded. Check the dates and try again.',
      );
    } finally {
      setReportBusy(false);
    }
  }

  async function createExport(event: FormEvent) {
    event.preventDefault();
    if (!report) return;
    const input = workforceReportExportCreateSchema.safeParse({
      kind: 'workforce_headcount_csv',
      parameters: {
        asOf: report.asOf,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
      },
      reason: exportReason,
    });
    if (!input.success) {
      setMessage('Give a reason of 3 to 240 characters for the audit record.');
      return;
    }
    setExportBusy(true);
    setMessage('');
    const idempotencyKey = exportKey || crypto.randomUUID();
    if (!exportKey) setExportKey(idempotencyKey);
    try {
      const response = await fetch(`/api/v1/tenants/${tenantId}/exports`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify(input.data),
      });
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Unavailable');
      const artifact = workforceReportExportViewSchema.parse(
        await response.json(),
      );
      setExportArtifact(artifact);
      setExportKey('');
      setMessage(
        artifact.status === 'ready'
          ? 'Your aggregate CSV is ready to download.'
          : 'Export accepted. Kinto is preparing the aggregate CSV.',
      );
    } catch {
      setMessage(
        'The export could not be created. Retry to safely reuse the same request.',
      );
    } finally {
      setExportBusy(false);
    }
  }

  if (state !== 'ready' || !report) {
    const copy = {
      loading: 'Loading workforce reports…',
      ready: '',
      'select-company': 'Choose a company workspace before viewing reports.',
      'signed-out': 'Sign in to view workforce reports.',
      denied:
        'Only company owners and HR administrators can view workforce reports.',
      error: 'Workforce reports are unavailable. Refresh and try again.',
    }[state];
    return (
      <section className="notice">
        <p role={state === 'error' ? 'alert' : 'status'}>{copy}</p>
        {(state === 'signed-out' || state === 'select-company') && (
          <Link href="/login">Open account access →</Link>
        )}
      </section>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">WORKFORCE REPORTS</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Review aggregate headcount movement and prepare an audited CSV.
          </p>
        </div>
      </div>

      <form className="settings-card report-controls" onSubmit={submitReport}>
        <div className="section-heading">
          <h2>Report dates</h2>
          <span>Asia/Karachi calendar</span>
        </div>
        <div className="report-date-grid">
          <label>
            Headcount as of
            <input
              type="date"
              value={asOf}
              onChange={(event) => updateDate(setAsOf, event.target.value)}
              required
            />
          </label>
          <label>
            Movement period start
            <input
              type="date"
              value={periodStart}
              onChange={(event) =>
                updateDate(setPeriodStart, event.target.value)
              }
              required
            />
          </label>
          <label>
            Movement period end
            <input
              type="date"
              value={periodEnd}
              onChange={(event) => updateDate(setPeriodEnd, event.target.value)}
              required
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={reportBusy}
          >
            {reportBusy ? 'Updating…' : 'Update report'}
          </button>
        </div>
      </form>

      <section className="report-metrics" aria-label="Workforce totals">
        <article className="settings-card">
          <span>Headcount</span>
          <strong>{report.headcount}</strong>
          <small>Active on {report.asOf}</small>
        </article>
        <article className="settings-card">
          <span>Joiners</span>
          <strong>{report.joiners}</strong>
          <small>During selected period</small>
        </article>
        <article className="settings-card">
          <span>Leavers</span>
          <strong>{report.leavers}</strong>
          <small>During selected period</small>
        </article>
        <article className="settings-card">
          <span>Unassigned</span>
          <strong>{report.unassignedHeadcount}</strong>
          <small>No active department</small>
        </article>
      </section>

      <section className="settings-card report-departments">
        <div className="section-heading">
          <h2>Department headcount</h2>
          <span>{report.departments.length} departments</span>
        </div>
        {report.departments.length ? (
          <div className="report-table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Department</th>
                  <th scope="col">Headcount</th>
                </tr>
              </thead>
              <tbody>
                {report.departments.map((department) => (
                  <tr key={department.departmentId}>
                    <td>{department.departmentCode}</td>
                    <td>{department.departmentName}</td>
                    <td>{department.headcount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No active department headcount.</p>
        )}
      </section>

      <section className="settings-card report-export">
        <div className="section-heading">
          <h2>Audited CSV export</h2>
          <span>Aggregate data only · expires after 24 hours</span>
        </div>
        <form
          className="settings-form report-export-form"
          onSubmit={createExport}
        >
          <label>
            Export reason
            <input
              value={exportReason}
              minLength={3}
              maxLength={240}
              onChange={(event) => {
                setExportReason(event.target.value);
                setExportKey('');
                setMessage('');
              }}
              required
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={exportBusy}
          >
            {exportBusy ? 'Requesting…' : 'Prepare CSV'}
          </button>
        </form>
        {exportArtifact && (
          <div className="export-result">
            <span className={`request-status ${exportArtifact.status}`}>
              {exportArtifact.status}
            </span>
            <p>
              Created {formatDateTime(exportArtifact.createdAt)} · expires{' '}
              {formatDateTime(exportArtifact.expiresAt)}
            </p>
            {exportArtifact.status === 'ready' && (
              <a
                className="primary-button"
                href={`/api/v1/tenants/${tenantId}/exports/${exportArtifact.id}/content`}
              >
                Download aggregate CSV
              </a>
            )}
          </div>
        )}
        <p className="audit-note">
          Creation and download are authorized again and recorded in the company
          audit trail. Employee names, identifiers, contact details and pay are
          excluded.
        </p>
      </section>

      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </>
  );
}
