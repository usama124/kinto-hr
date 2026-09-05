'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';

type AuditItem = {
  id: string;
  actorId: string;
  action: string;
  reason: string | null;
  resourceId: string;
  createdAt: string;
};
type AuditPage = { items: AuditItem[]; nextCursor: string | null };
type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actionPattern = /^[a-z][a-z0-9_.]{0,99}$/;
const cursorPattern = /^[A-Za-z0-9_-]{48}$/;

function parseAuditPage(value: unknown): AuditPage {
  if (
    !value ||
    typeof value !== 'object' ||
    !('items' in value) ||
    !Array.isArray(value.items)
  )
    throw new Error('Invalid audit page');
  const nextCursor = 'nextCursor' in value ? value.nextCursor : undefined;
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' || !cursorPattern.test(nextCursor))
  )
    throw new Error('Invalid audit cursor');
  if (
    !value.items.every(
      (item): item is AuditItem =>
        !!item &&
        typeof item === 'object' &&
        'id' in item &&
        typeof item.id === 'string' &&
        uuid.test(item.id) &&
        'actorId' in item &&
        typeof item.actorId === 'string' &&
        uuid.test(item.actorId) &&
        'action' in item &&
        typeof item.action === 'string' &&
        actionPattern.test(item.action) &&
        'reason' in item &&
        (item.reason === null ||
          (typeof item.reason === 'string' && item.reason.length <= 240)) &&
        'resourceId' in item &&
        typeof item.resourceId === 'string' &&
        uuid.test(item.resourceId) &&
        'createdAt' in item &&
        typeof item.createdAt === 'string' &&
        Number.isFinite(Date.parse(item.createdAt)),
    )
  )
    throw new Error('Invalid audit item');
  return { items: value.items, nextCursor };
}

export default function SecurityAudit() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [items, setItems] = useState<AuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadAudit(
    selectedTenant: string,
    filter: string,
    cursor?: string,
  ) {
    const params = new URLSearchParams({ limit: '25' });
    if (filter) params.set('action', filter);
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(
      `/api/v1/tenants/${selectedTenant}/security-audit?${params}`,
      { cache: 'no-store' },
    );
    if (response.status === 401) return setState('signed-out');
    if (response.status === 403) return setState('denied');
    if (!response.ok) throw new Error('Unavailable');
    const page = parseAuditPage(await response.json());
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
    setState('ready');
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
          !('selectedTenantId' in data) ||
          (data.selectedTenantId !== null &&
            (typeof data.selectedTenantId !== 'string' ||
              !uuid.test(data.selectedTenantId))) ||
          !('tenants' in data) ||
          !Array.isArray(data.tenants)
        )
          throw new Error('Invalid session');
        if (!data.selectedTenantId) return setState('select-company');
        const tenant = data.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === data.selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string',
        );
        if (!tenant || !('name' in tenant) || typeof tenant.name !== 'string')
          throw new Error('Invalid company');
        setTenantId(data.selectedTenantId);
        setCompanyName(tenant.name);
        await loadAudit(data.selectedTenantId, '');
      } catch {
        setState('error');
      }
    })();
  }, []);

  async function applyFilter(event: FormEvent) {
    event.preventDefault();
    const normalized = action.trim();
    if (normalized && !actionPattern.test(normalized)) return setState('error');
    setBusy(true);
    try {
      await loadAudit(tenantId, normalized);
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    try {
      await loadAudit(tenantId, action.trim(), nextCursor);
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SECURITY AUDIT</p>
          <h1>Company activity, clearly recorded.</h1>
          <p className="subtitle">
            Review sensitive administrative changes inside the selected company.
          </p>
        </div>
      </div>
      {state === 'loading' && (
        <section className="notice" role="status">
          Loading security activity…
        </section>
      )}
      {state === 'signed-out' && (
        <section className="notice">
          <p role="status">Sign in to review company activity.</p>
          <Link href="/login">Open account access →</Link>
        </section>
      )}
      {state === 'select-company' && (
        <section className="notice">
          <p role="status">
            Choose a company workspace before reviewing activity.
          </p>
          <Link href="/login">Choose a company →</Link>
        </section>
      )}
      {state === 'denied' && (
        <section className="notice" role="status">
          Owner access with recent multi-factor authentication is required.
        </section>
      )}
      {state === 'error' && (
        <section className="notice" role="alert">
          Security activity is unavailable. Refresh the page and try again.
        </section>
      )}
      {state === 'ready' && (
        <section aria-labelledby="audit-heading">
          <div className="section-heading">
            <h2 id="audit-heading">{companyName}</h2>
            <span>Newest activity first</span>
          </div>
          <form className="audit-filter" onSubmit={applyFilter}>
            <label htmlFor="audit-action">Action</label>
            <input
              id="audit-action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder="membership.roles_changed"
              pattern="[a-z][a-z0-9_.]*"
              maxLength={100}
            />
            <button className="secondary-button" disabled={busy}>
              Apply filter
            </button>
          </form>
          {items.length === 0 ? (
            <p className="empty-state" role="status">
              No matching security activity.
            </p>
          ) : (
            <ol className="audit-list">
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.action.replaceAll('_', ' ')}</strong>
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString('en-PK', {
                        timeZone: 'Asia/Karachi',
                      })}{' '}
                      PKT
                    </time>
                  </div>
                  <p>
                    {item.reason ?? 'No reason recorded for this system event.'}
                  </p>
                  <small>
                    Actor {item.actorId} · Resource {item.resourceId}
                  </small>
                </li>
              ))}
            </ol>
          )}
          {nextCursor && (
            <button
              className="secondary-button audit-more"
              disabled={busy}
              onClick={() => void loadMore()}
            >
              {busy ? 'Loading…' : 'Load more activity'}
            </button>
          )}
          <p className="audit-note">
            This view contains tenant audit events only. Platform operator
            activity is kept separately and is never exposed here.
          </p>
        </section>
      )}
    </>
  );
}
