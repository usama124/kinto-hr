'use client';
import { useCallback, useEffect, useState } from 'react';
import { healthSchema } from '@kinto/contracts';
export function ConnectionStatus() {
  const [state, setState] = useState<'checking' | 'ready' | 'unavailable'>(
    'checking',
  );
  const check = useCallback(async (signal?: AbortSignal) => {
    setState('checking');
    try {
      const timeout = AbortSignal.timeout(5000);
      const response = await fetch('/api/v1/health/ready', {
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error('Unavailable');
      healthSchema.parse(await response.json());
      if (!signal?.aborted) setState('ready');
    } catch {
      if (!signal?.aborted) setState('unavailable');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
  }, [check]);
  return (
    <div className="connection">
      <div>
        <span className={`status-dot ${state}`} />
        <strong>API &amp; database</strong>
        <p role="status">
          {state === 'ready'
            ? 'Connected · runtime role verified'
            : state === 'checking'
              ? 'Checking connection…'
              : 'Not connected · start the local services'}
        </p>
      </div>
      <button
        className="secondary-button"
        disabled={state === 'checking'}
        onClick={() => void check()}
      >
        Check connection
      </button>
    </div>
  );
}
