import type { ProviderLogoutHealth } from '@kinto/database';

export type LogoutHealthReport = {
  status: 'ready' | 'unavailable';
  alerts: string[];
  backlog: ProviderLogoutHealth | null;
};

// No raw exception, URL, namespace, token or receipt identifier in diagnostics.
export async function checkLogoutHealth(
  read: () => Promise<ProviderLogoutHealth>,
  maxPendingSeconds = 300,
  maxIdleSeconds = 30,
  timeoutMs = 5000,
): Promise<LogoutHealthReport> {
  if (
    [maxPendingSeconds, maxIdleSeconds, timeoutMs].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  )
    throw new Error('Invalid logout monitoring thresholds');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const backlog = await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
      }),
    ]);
    if (
      !Number.isSafeInteger(backlog.pending) ||
      !Number.isSafeInteger(backlog.unattempted) ||
      backlog.pending < 0 ||
      backlog.unattempted < 0 ||
      backlog.unattempted > backlog.pending ||
      !Number.isFinite(backlog.oldestPendingSeconds) ||
      backlog.oldestPendingSeconds < 0 ||
      (backlog.lastAttemptSeconds !== null &&
        (!Number.isFinite(backlog.lastAttemptSeconds) ||
          backlog.lastAttemptSeconds < 0))
    )
      throw new Error('Invalid health snapshot');
    const alerts: string[] = [];
    if (backlog.pending > 0) {
      if (backlog.oldestPendingSeconds >= maxPendingSeconds)
        alerts.push('logout_backlog_overdue');
      if (
        backlog.oldestPendingSeconds >= maxIdleSeconds &&
        (backlog.lastAttemptSeconds === null ||
          backlog.lastAttemptSeconds >= maxIdleSeconds)
      )
        alerts.push('logout_reconciliation_stalled');
    }
    return {
      status: alerts.length ? 'unavailable' : 'ready',
      alerts,
      backlog: {
        pending: backlog.pending,
        unattempted: backlog.unattempted,
        oldestPendingSeconds: backlog.oldestPendingSeconds,
        lastAttemptSeconds: backlog.lastAttemptSeconds,
      },
    };
  } catch {
    return {
      status: 'unavailable',
      alerts: ['logout_probe_unavailable'],
      backlog: null,
    };
  } finally {
    clearTimeout(timer);
  }
}
