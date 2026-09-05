'use client';

import { useEffect, useState } from 'react';

type AccessState = 'loading' | 'disabled' | 'anonymous' | 'signed-in' | 'error';
type Tenant = {
  id: string;
  name: string;
  roles: string[];
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tenantRoles = new Set([
  'owner',
  'hr_admin',
  'payroll_preparer',
  'payroll_approver',
  'employee',
]);
export default function Login() {
  const [state, setState] = useState<AccessState>('loading');
  const [csrf, setCsrf] = useState('');
  const [busy, setBusy] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  async function refresh() {
    setState('loading');
    setCsrf('');
    setTenants([]);
    setSelectedTenantId(null);
    try {
      const response = await fetch('/api/v1/auth/session', {
        cache: 'no-store',
      });
      if (response.status === 404) return setState('disabled');
      if (response.status === 401) return setState('anonymous');
      if (!response.ok) throw new Error('Unavailable');
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !('csrfToken' in data) ||
        typeof data.csrfToken !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken) ||
        !('selectedTenantId' in data) ||
        (data.selectedTenantId !== null &&
          (typeof data.selectedTenantId !== 'string' ||
            !uuid.test(data.selectedTenantId))) ||
        !('tenants' in data) ||
        !Array.isArray(data.tenants) ||
        !data.tenants.every(
          (tenant): tenant is Tenant =>
            !!tenant &&
            typeof tenant === 'object' &&
            'id' in tenant &&
            typeof tenant.id === 'string' &&
            uuid.test(tenant.id) &&
            'name' in tenant &&
            typeof tenant.name === 'string' &&
            tenant.name.length >= 1 &&
            tenant.name.length <= 160 &&
            'roles' in tenant &&
            Array.isArray(tenant.roles) &&
            tenant.roles.length >= 1 &&
            tenant.roles.length <= tenantRoles.size &&
            new Set(tenant.roles).size === tenant.roles.length &&
            tenant.roles.every(
              (role: unknown) =>
                typeof role === 'string' && tenantRoles.has(role),
            ),
        )
      )
        throw new Error('Invalid session');
      if (
        data.selectedTenantId !== null &&
        !data.tenants.some(
          (tenant: Tenant) => tenant.id === data.selectedTenantId,
        )
      )
        throw new Error('Invalid selection');
      setCsrf(data.csrfToken);
      setTenants(data.tenants);
      setSelectedTenantId(data.selectedTenantId);
      setState('signed-in');
    } catch {
      setState('error');
    }
  }
  async function selectTenant(tenantId: string) {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/auth/tenant', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({ tenantId }),
      });
      if (!response.ok) throw new Error('Unavailable');
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== 'object' ||
        !('selectedTenantId' in data) ||
        data.selectedTenantId !== tenantId ||
        !('csrfToken' in data) ||
        typeof data.csrfToken !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)
      )
        throw new Error('Invalid selection');
      setSelectedTenantId(tenantId);
      setCsrf(data.csrfToken);
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function logout() {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
      });
      if (!response.ok && response.status !== 401)
        throw new Error('Unavailable');
      await refresh();
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
          <p className="eyebrow">ACCOUNT ACCESS</p>
          <h1>Sign in to Kinto.</h1>
          <p className="subtitle">
            Use the account provided by your administrator.
          </p>
        </div>
      </div>
      <section className="notice" aria-label="Account access">
        <p role="status">
          {state === 'loading' && 'Checking account access…'}
          {state === 'disabled' &&
            'Sign-in is not enabled in this environment yet.'}
          {state === 'anonymous' &&
            'Continue to your identity provider to sign in.'}
          {state === 'signed-in' &&
            (selectedTenantId
              ? `You are signed in to ${tenants.find((tenant) => tenant.id === selectedTenantId)?.name ?? 'your company'}.`
              : tenants.length
                ? 'You are signed in. Choose a company workspace.'
                : 'You are signed in, but no active company access is available.')}
          {state === 'error' &&
            'Account access is unavailable. Please try again.'}
        </p>
        {state === 'anonymous' && (
          <a className="primary-button" href="/api/v1/auth/login">
            Continue to sign in
          </a>
        )}
        {state === 'signed-in' && tenants.length > 0 && (
          <div className="workspace-choices" aria-label="Company workspaces">
            {tenants.map((tenant) => (
              <button
                className={
                  tenant.id === selectedTenantId
                    ? 'workspace-choice selected'
                    : 'workspace-choice'
                }
                disabled={busy || tenant.id === selectedTenantId}
                key={tenant.id}
                onClick={() => void selectTenant(tenant.id)}
              >
                <strong>{tenant.name}</strong>
                <span>{tenant.roles.join(', ').replaceAll('_', ' ')}</span>
              </button>
            ))}
          </div>
        )}
        {state === 'error' && (
          <button className="primary-button" onClick={() => void refresh()}>
            Try again
          </button>
        )}
        <p>
          Only platform admins create companies. Your company admin or HR
          creates employee accounts. There is no self-signup.
        </p>
        <p>
          Password recovery is available only when an approved identity provider
          is configured. Company access appears only after an administrator has
          provisioned and activated your account. Contact your administrator if
          you cannot access your account.
        </p>
        {state === 'signed-in' && (
          <>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void logout()}
            >
              {busy ? 'Updating session…' : 'Sign out of Kinto'}
            </button>
            <p>
              Signing out ends this Kinto session; it does not sign you out of
              your identity provider.
            </p>
          </>
        )}
      </section>
    </>
  );
}
