import { describe, expect, it } from 'vitest';
import {
  healthAlerts,
  prometheusMetrics,
  unavailableHealth,
  type HealthSnapshot,
} from './health';
import { startMonitor } from './monitor-server';
import type { AddressInfo } from 'node:net';

const healthy: HealthSnapshot = {
  dependenciesReady: true,
  activeWorkers: 2,
  pending: 3,
  retry: 1,
  dead: 0,
  oldestDueSeconds: 299,
};

describe('operational health and private metrics', () => {
  it('distinguishes reachable dependencies from a running worker', () => {
    expect(healthAlerts(healthy)).toEqual([]);
    expect(healthAlerts({ ...healthy, activeWorkers: 0 })).toEqual([
      'worker_missing',
    ]);
    expect(
      healthAlerts({ ...healthy, dead: 1, oldestDueSeconds: 300 }),
    ).toEqual(['dead_deliveries', 'delivery_overdue']);
    expect(healthAlerts(unavailableHealth)).toEqual([
      'dependencies_unavailable',
    ]);
  });
  it('exports only bounded aggregate series without tenant IDs or record content', () => {
    const metrics = prometheusMetrics(healthy);
    expect(metrics).toContain('kinto_worker_active_instances 2\n');
    expect(metrics).toContain('kinto_outbox_oldest_due_seconds 299\n');
    expect(metrics.split('\n').filter(Boolean)).toHaveLength(12);
    expect(metrics).not.toMatch(/tenant|employee|password|\{/);
  });
  it('binds only to loopback, rejects unknown routes and returns 503 for actionable failure', async () => {
    let state = healthy;
    const server = await startMonitor(async () => state, 0);
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    try {
      expect(address.address).toBe('127.0.0.1');
      expect((await fetch(`${url}/health/ready`)).status).toBe(200);
      const metrics = await fetch(`${url}/metrics`);
      expect(metrics.headers.get('content-type')).toContain('version=0.0.4');
      expect(metrics.headers.get('cache-control')).toBe('no-store');
      state = { ...healthy, activeWorkers: 0 };
      const failed = await fetch(`${url}/health/ready`);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({
        status: 'unavailable',
        alerts: ['worker_missing'],
      });
      expect((await fetch(`${url}/metrics`, { method: 'POST' })).status).toBe(
        404,
      );
      expect((await fetch(`${url}/employees`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('redacts collection errors and bounds/shared concurrent scrape requests', async () => {
    let mode: 'error' | 'stall' = 'error';
    let calls = 0;
    let release!: (health: HealthSnapshot) => void;
    const server = await startMonitor(
      async () => {
        calls++;
        if (mode === 'error')
          throw new Error('postgresql://secret:private@example/employee');
        return new Promise<HealthSnapshot>((resolve) => {
          release = resolve;
        });
      },
      0,
      30,
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const failed = await fetch(`${url}/metrics`);
      expect(failed.status).toBe(200);
      const text = await failed.text();
      expect(text).toContain('kinto_worker_dependencies_ready 0');
      expect(text).not.toMatch(/secret|private|example|postgresql/);
      mode = 'stall';
      calls = 0;
      const responses = await Promise.all([
        fetch(`${url}/health/ready`),
        fetch(`${url}/health/ready`),
      ]);
      expect(responses.map((r) => r.status)).toEqual([503, 503]);
      expect(calls).toBe(1);
    } finally {
      release?.(healthy);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
