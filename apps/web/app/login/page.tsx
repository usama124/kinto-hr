'use client';

import { useEffect, useState } from 'react';

type AccessState = 'loading' | 'disabled' | 'anonymous' | 'signed-in' | 'error';
export default function Login() {
  const [state, setState] = useState<AccessState>('loading');
  const [csrf, setCsrf] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setState('loading');
    setCsrf('');
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
        !/^[A-Za-z0-9_-]{43}$/.test(data.csrfToken)
      )
        throw new Error('Invalid session');
      setCsrf(data.csrfToken);
      setState('signed-in');
    } catch {
      setState('error');
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
            'You are signed in. Company workspaces are not available yet.'}
          {state === 'error' &&
            'Account access is unavailable. Please try again.'}
        </p>
        {state === 'anonymous' && (
          <a className="primary-button" href="/api/v1/auth/login">
            Continue to sign in
          </a>
        )}
        {state === 'signed-in' && (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void logout()}
          >
            {busy ? 'Signing out…' : 'Sign out of Kinto'}
          </button>
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
          Password recovery and account activation are pending identity-provider
          setup. Contact your administrator if you cannot access your account.
        </p>
        {state === 'signed-in' && (
          <p>
            Signing out ends this Kinto session; it does not sign you out of
            your identity provider.
          </p>
        )}
      </section>
    </>
  );
}
