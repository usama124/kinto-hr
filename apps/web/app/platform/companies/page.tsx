'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  companyProvisioningSchema,
  companyProvisioningResultSchema,
  platformAccessSchema,
  type CompanyProvisioning,
  type CompanyProvisioningResult,
} from '@kinto/contracts';

type State = 'loading' | 'ready' | 'signed-out' | 'denied' | 'error';
type Pending = { key: string; input: CompanyProvisioning };

export default function CompanyProvisioningPage() {
  const [state, setState] = useState<State>('loading');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [limit, setLimit] = useState('5');
  const [billingMode, setBillingMode] =
    useState<CompanyProvisioning['billingMode']>('free');
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<CompanyProvisioningResult | null>(null);
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
          !('csrfToken' in session) ||
          typeof session.csrfToken !== 'string' ||
          session.csrfToken.length < 1
        )
          throw new Error('Invalid session');
        const access = await fetch('/api/v1/platform/access', options);
        if (access.status === 401 || access.status === 403)
          return setState(access.status === 401 ? 'signed-out' : 'denied');
        if (!access.ok) throw new Error('Unavailable');
        platformAccessSchema.parse(await access.json());
        setCsrf(session.csrfToken);
        setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function send(request: Pending) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/v1/platform/tenants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': request.key,
        },
        body: JSON.stringify(request.input),
      });
      if (response.status === 401 || response.status === 403) {
        setPending(null);
        setResult(null);
        return setState(response.status === 401 ? 'signed-out' : 'denied');
      }
      if (response.status === 400 || response.status === 409) {
        setPending(null);
        setResult(null);
        setMessage(
          'Company creation refused. Review the approved package and owner details; changed retry data is not accepted.',
        );
        return;
      }
      if (!response.ok) throw new Error('Unconfirmed');
      const parsed = companyProvisioningResultSchema.parse(
        await response.json(),
      );
      if (
        result &&
        (result.tenantId !== parsed.tenantId ||
          result.provisioningRequestId !== parsed.provisioningRequestId)
      )
        throw new Error('Changed request');
      setResult(parsed);
      if (parsed.status === 'pending_identity_provider')
        setMessage(
          'Company recorded. Owner setup is pending because the provider is disabled or unavailable. No owner access is granted; retry this same request.',
        );
      else {
        setPending(null);
        setMessage(
          {
            pending_activation:
              'Owner setup delivery recorded. Access remains pending until verified activation.',
            active:
              'The original owner request is already activated. This replay did not create another company.',
            failed:
              'Owner setup is marked failed. Contact the operator before creating another company.',
            revoked:
              'Owner setup is revoked. This does not restore owner access.',
          }[parsed.status],
        );
      }
    } catch {
      setMessage(
        'Company creation could not be confirmed. Retry the same request to avoid creating a duplicate company.',
      );
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || pending) return;
    const input = companyProvisioningSchema.safeParse({
      companyName,
      initialOwnerEmail: email,
      employeeLimit: Number(limit),
      billingMode,
    });
    if (!input.success) {
      setMessage(
        'Provide a company name, valid owner email and approved employee package. Free access is limited to five employees.',
      );
      return;
    }
    const request = { key: crypto.randomUUID(), input: input.data };
    setPending(request);
    setResult(null);
    void send(request);
  }

  if (state !== 'ready')
    return (
      <p className="notice">
        {
          {
            loading: 'Checking platform access…',
            'signed-out': 'Sign in to create a company account.',
            denied:
              'Only an active platform operator with recent verification can create companies.',
            error: 'Platform access is unavailable. Refresh and try again.',
          }[state]
        }
      </p>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PLATFORM ADMINISTRATION</p>
          <h1>Create company account</h1>
          <p className="subtitle">
            Operator-led onboarding. Companies cannot sign themselves up.
          </p>
        </div>
      </div>
      <section className="settings-card" aria-label="Company provisioning">
        <p>
          Free is the five-employee package. Complimentary access suppresses
          collection; manual paid is a provisioning classification, not proof of
          payment. Pricing, invoices and collection are not enabled by this
          form.
        </p>
        <p>
          Owner setup is delivered by the configured identity provider. Creating
          a request does not create a password or grant immediate owner access.
        </p>
        <p>
          The exact retry key stays in page memory only. Closing or refreshing
          this page loses it. Reconcile unresolved requests with the operator
          before starting another company request.
        </p>
        {message && <p role="status">{message}</p>}
        {result && (
          <div className="document-summary">
            <div>
              <strong>Company {result.tenantId}</strong>
              <small>Request {result.provisioningRequestId}</small>
              <small>
                {result.status.replaceAll('_', ' ')}
                {result.replayed ? ' · Existing request replayed' : ''}
              </small>
            </div>
          </div>
        )}
        {result && !pending ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setResult(null);
              setMessage('');
              setCompanyName('');
              setEmail('');
              setLimit('5');
              setBillingMode('free');
            }}
          >
            Create another company
          </button>
        ) : (
          <form className="settings-form" onSubmit={submit}>
            <label>
              Company name
              <input
                required
                maxLength={160}
                value={companyName}
                disabled={busy || pending !== null}
                onChange={(event) => setCompanyName(event.target.value)}
              />
            </label>
            <label>
              Initial owner email
              <input
                type="email"
                required
                maxLength={320}
                value={email}
                disabled={busy || pending !== null}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Access model
              <select
                value={billingMode}
                disabled={busy || pending !== null}
                onChange={(event) => {
                  const mode = event.target
                    .value as CompanyProvisioning['billingMode'];
                  setBillingMode(mode);
                  if (mode === 'free') setLimit('5');
                }}
              >
                <option value="free">Free</option>
                <option value="complimentary">Complimentary</option>
                <option value="manual_paid">Manual paid</option>
              </select>
            </label>
            <label>
              Employee package
              <select
                value={limit}
                disabled={busy || pending !== null || billingMode === 'free'}
                onChange={(event) => setLimit(event.target.value)}
              >
                {[5, 20, 50, 100, 250].map((value) => (
                  <option key={value} value={value}>
                    {value} employees
                  </option>
                ))}
              </select>
            </label>
            {pending ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void send(pending)}
              >
                Retry same company request
              </button>
            ) : (
              <button type="submit" className="primary-button" disabled={busy}>
                Create company
              </button>
            )}
          </form>
        )}
      </section>
    </>
  );
}
