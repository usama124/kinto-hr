'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  entitlementSnapshotSchema,
  type EntitlementSnapshot,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function Entitlements() {
  const [state, setState] = useState<ViewState>('loading');
  const [companyName, setCompanyName] = useState('');
  const [snapshot, setSnapshot] = useState<EntitlementSnapshot | null>(null);

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
            typeof candidate.name === 'string',
        );
        if (!tenant || !('name' in tenant) || typeof tenant.name !== 'string')
          throw new Error('Invalid company');
        setCompanyName(tenant.name);
        const response = await fetch(
          `/api/v1/tenants/${session.selectedTenantId}/entitlements`,
          { cache: 'no-store' },
        );
        if (response.status === 401) return setState('signed-out');
        if (response.status === 403) return setState('denied');
        if (!response.ok) throw new Error('Unavailable');
        setSnapshot(entitlementSnapshotSchema.parse(await response.json()));
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  if (state !== 'ready' || !snapshot) {
    const copy = {
      loading: 'Loading plan and capacity…',
      ready: '',
      'select-company': 'Choose a company workspace before viewing its plan.',
      'signed-out': 'Sign in to view company plan and capacity.',
      denied:
        'Recent multi-factor authentication and company access are required.',
      error: 'Plan and capacity are unavailable. Refresh and try again.',
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

  const usage = Math.min(
    100,
    Math.round((snapshot.activeEmployees / snapshot.employeeLimit) * 100),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PLAN &amp; CAPACITY</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            The effective package and authoritative employee capacity for this
            company.
          </p>
        </div>
      </div>
      <section className="entitlement-grid">
        <article className="settings-card plan-summary">
          <p className="eyebrow">CURRENT PACKAGE</p>
          <h2>{snapshot.plan.code}</h2>
          <p>
            Catalog version {snapshot.plan.version} · Entitlement version{' '}
            {snapshot.entitlementVersion}
          </p>
          <span className="preview-badge">
            {snapshot.billingMode === 'complimentary'
              ? 'Complimentary · no collection'
              : snapshot.billingMode.replace('_', ' ')}
          </span>
        </article>
        <article className="settings-card capacity-card">
          <div className="section-heading">
            <h2>Employee capacity</h2>
            <span>{snapshot.employeeLimit} seats</span>
          </div>
          <strong className="capacity-number">
            {snapshot.activeEmployees} active
          </strong>
          <div
            className="capacity-track"
            role="progressbar"
            aria-label="Employee capacity used"
            aria-valuemin={0}
            aria-valuemax={snapshot.employeeLimit}
            aria-valuenow={snapshot.activeEmployees}
          >
            <span style={{ width: `${usage}%` }} />
          </div>
          <p>{snapshot.availableEmployeeSeats} seats available</p>
        </article>
      </section>
      <section className="settings-card">
        <div className="section-heading">
          <h2>Enabled capabilities</h2>
          <span>Effective subscription</span>
        </div>
        <p>
          Company setup and employee draft records are enabled. Employee
          activation/termination, attendance, leave, payroll and billing
          collection remain unavailable until their tested modules are released.
        </p>
        <p className="audit-note">
          Package seeds have no production prices and cannot issue an invoice.
          Capacity decisions use database state, not this screen.
        </p>
      </section>
    </>
  );
}
