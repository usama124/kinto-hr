import { createServer } from 'node:http';
import {
  healthAlerts,
  prometheusMetrics,
  unavailableHealth,
  type HealthSnapshot,
} from './health';

// Private host/sidecar endpoint only; deliberately no configurable public bind.
export async function startMonitor(
  collect: () => Promise<HealthSnapshot>,
  port: number,
  timeoutMs = 5000,
) {
  // Share an in-flight read so concurrent scrapes cannot exhaust DB connections.
  let inflight: Promise<HealthSnapshot> | undefined;
  function snapshot() {
    if (!inflight)
      inflight = collect().finally(() => {
        inflight = undefined;
      });
    return inflight;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      req.method !== 'GET' ||
      !['/metrics', '/health/ready'].includes(req.url || '')
    ) {
      res.writeHead(404).end();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    let health: HealthSnapshot;
    try {
      health = await Promise.race([
        snapshot(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch {
      health = unavailableHealth;
    } finally {
      clearTimeout(timer);
    }
    if (req.url === '/metrics') {
      // Always scrapeable: failure is an explicit gauge, not a stale success value.
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.end(prometheusMetrics(health));
    } else {
      const alerts = healthAlerts(health);
      res.writeHead(alerts.length ? 503 : 200, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          status: alerts.length ? 'unavailable' : 'ready',
          alerts,
        }),
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
