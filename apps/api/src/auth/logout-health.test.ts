import { expect, it } from 'vitest';
import { checkLogoutHealth } from './logout-health';

const fresh = {
  pending: 1,
  unattempted: 1,
  oldestPendingSeconds: 29,
  lastAttemptSeconds: null,
};
it('distinguishes fresh, overdue, unattempted and stalled reconciliation', async () => {
  expect((await checkLogoutHealth(async () => fresh)).alerts).toEqual([]);
  expect(
    (
      await checkLogoutHealth(async () => ({
        ...fresh,
        oldestPendingSeconds: 30,
      }))
    ).alerts,
  ).toEqual(['logout_reconciliation_stalled']);
  expect(
    (
      await checkLogoutHealth(async () => ({
        ...fresh,
        unattempted: 0,
        oldestPendingSeconds: 300,
        lastAttemptSeconds: 0,
      }))
    ).alerts,
  ).toEqual(['logout_backlog_overdue']);
  const stalled = await checkLogoutHealth(async () => ({
    ...fresh,
    unattempted: 0,
    oldestPendingSeconds: 300,
    lastAttemptSeconds: 30,
  }));
  expect(stalled.status).toBe('unavailable');
  expect(stalled.alerts).toEqual([
    'logout_backlog_overdue',
    'logout_reconciliation_stalled',
  ]);
  expect(
    (
      await checkLogoutHealth(async () => ({
        ...fresh,
        pending: 0,
        unattempted: 0,
        oldestPendingSeconds: 0,
      }))
    ).status,
  ).toBe('ready');
  expect(
    (await checkLogoutHealth(async () => fresh, 20, 10)).alerts,
  ).toHaveLength(2);
});
it('redacts dependency failures and bounds hung probes', async () => {
  const failed = await checkLogoutHealth(async () => {
    throw new Error('postgresql://secret:private@example/customer');
  });
  expect(failed).toEqual({
    status: 'unavailable',
    alerts: ['logout_probe_unavailable'],
    backlog: null,
  });
  expect(
    await checkLogoutHealth(() => new Promise(() => {}), 300, 30, 10),
  ).toEqual(failed);
  expect(JSON.stringify(failed)).not.toMatch(
    /secret|private|example|postgresql/,
  );
});
it('rejects invalid thresholds and malformed aggregate data', async () => {
  for (const value of [0, -1, 1.5, Infinity, NaN]) {
    await expect(checkLogoutHealth(async () => fresh, value)).rejects.toThrow(
      'Invalid logout monitoring thresholds',
    );
  }
  for (const change of [
    { pending: -1 },
    { unattempted: 2 },
    { oldestPendingSeconds: NaN },
    { lastAttemptSeconds: -1 },
  ]) {
    expect(
      (await checkLogoutHealth(async () => ({ ...fresh, ...change }))).alerts,
    ).toEqual(['logout_probe_unavailable']);
  }
});

it('projects only reviewed aggregate fields', async () => {
  const report = await checkLogoutHealth(async () => ({
    ...fresh,
    targetHash: 'private',
    error: 'secret',
  }));
  expect(report.backlog).toEqual(fresh);
  expect(JSON.stringify(report)).not.toMatch(/private|secret|targetHash/);
});
