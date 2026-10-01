'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  platformCompanyListSchema,
  type PlatformCompanyList,
} from '@kinto/contracts';

type State = 'loading' | 'ready' | 'signed-out' | 'denied' | 'error';
export default function CompanyDirectory() {
  const [state, setState] = useState<State>('loading');
  const [data, setData] = useState<PlatformCompanyList>({
    companies: [],
    nextCursor: null,
  });
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [history, setHistory] = useState<(string | null)[]>([null]);
  const [busy, setBusy] = useState(false);

  async function load(
    value: string,
    cursors: (string | null)[],
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: '25' });
    if (value) query.set('search', value);
    const cursor = cursors.at(-1);
    if (cursor) query.set('after', cursor);
    const response = await fetch(`/api/v1/platform/tenants?${query}`, {
      cache: 'no-store',
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      setData({ companies: [], nextCursor: null });
      setState(response.status === 401 ? 'signed-out' : 'denied');
      return;
    }
    if (!response.ok) throw new Error('Unavailable');
    setData(platformCompanyListSchema.parse(await response.json()));
    setHistory(cursors);
    setAppliedSearch(value);
    setState('ready');
  }
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/session', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 404)
          return setState('signed-out');
        if (!response.ok) throw new Error('Unavailable');
        await load('', [null], controller.signal);
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, []);
  async function change(value: string, cursors: (string | null)[]) {
    setBusy(true);
    try {
      await load(value, cursors);
    } catch {
      setData({ companies: [], nextCursor: null });
      setState('error');
    } finally {
      setBusy(false);
    }
  }
  if (state !== 'ready')
    return (
      <p className="notice">
        {
          {
            loading: 'Loading platform companies…',
            'signed-out': 'Sign in to review platform companies.',
            denied:
              'Only an active platform operator with recent verification can review companies.',
            error: 'Company directory is unavailable. Refresh and try again.',
          }[state]
        }
      </p>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PLATFORM ADMINISTRATION</p>
          <h1>Company directory</h1>
          <p className="subtitle">
            Company setup and base commercial metadata. No employee or owner
            personal data.
          </p>
        </div>
      </div>
      <section className="settings-card" aria-label="Platform companies">
        <Link href="/platform/companies" className="secondary-button">
          Create company account
        </Link>
        <p>
          Base subscription capacity does not include temporary grants or
          overrides. Manual paid is a billing classification, not proof of
          payment. Pricing, invoices and collection remain unavailable. Missing
          legacy setup is shown explicitly.
        </p>
        <form
          className="settings-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void change(search.trim(), [null]);
          }}
        >
          <label>
            Company name filter
            <input
              maxLength={160}
              disabled={busy}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button" disabled={busy}>
            Apply filter
          </button>
        </form>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void change(appliedSearch, [null])}
        >
          Refresh companies
        </button>
        <p role="status">
          {busy
            ? 'Loading companies…'
            : `Page ${history.length} · ${data.companies.length} companies shown`}
        </p>
        {data.companies.length === 0 ? (
          <p>No companies match this filter.</p>
        ) : (
          <ul className="document-list">
            {data.companies.map((company) => (
              <li key={company.id}>
                <div className="document-summary">
                  <div>
                    <strong>{company.name}</strong>
                    <small>{company.id}</small>
                  </div>
                  <span>{company.status}</span>
                </div>
                {company.status === 'active' && company.baseSubscription && (
                  <Link href={`/platform/companies/${company.id}/entitlements`}>
                    Manage entitlement controls
                  </Link>
                )}
                <p>
                  Owner setup:{' '}
                  {company.ownerSetupStatus?.replaceAll('_', ' ') ??
                    'No provisioning record'}
                </p>
                {company.baseSubscription ? (
                  <p>
                    Base plan: {company.baseSubscription.plan} v
                    {company.baseSubscription.planVersion} ·{' '}
                    {company.baseSubscription.employeeLimit} employees ·{' '}
                    {company.baseSubscription.billingMode.replaceAll('_', ' ')}
                  </p>
                ) : (
                  <p>No current base subscription</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="document-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || history.length === 1}
            onClick={() => void change(appliedSearch, history.slice(0, -1))}
          >
            Previous page
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || data.nextCursor === null}
            onClick={() => {
              if (data.nextCursor)
                void change(appliedSearch, [...history, data.nextCursor]);
            }}
          >
            Next page
          </button>
        </div>
        <p>
          Pages use a stable company-ID order; refreshing returns to the first
          page.
        </p>
      </section>
    </>
  );
}
