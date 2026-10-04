import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalConnectorClient } from './local-connector-client';

const binding = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  enrollmentId: '00000000-0000-4000-8000-000000000003',
};
const token = 'ke1_' + 'a'.repeat(43);
const credential = 'kc1_' + 'b'.repeat(43);
let createdAt: Date;
function record() {
  return {
    ...binding,
    id: '00000000-0000-4000-8000-000000000004',
    version: 1,
    status: 'active',
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 2592000000).toISOString(),
    revokedAt: null,
    scope: 'heartbeat_only',
    attendanceIngestionAvailable: false,
  };
}
let calls: IncomingMessage[];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const server = createServer((req, res) => {
  calls.push(req);
  handler(req, res);
});
let baseUrl: string;
let client: LocalConnectorClient;
function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
beforeEach(async () => {
  calls = [];
  createdAt = new Date(Date.now() - 1000);
  handler = (req, res) =>
    reply(
      res,
      req.url?.endsWith('redemption') ? 201 : 200,
      req.url?.endsWith('redemption')
        ? { connector: record(), credential }
        : { connector: record() },
    );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = new LocalConnectorClient({
    mode: 'local_test',
    baseUrl,
    binding,
    timeoutMs: 100,
  });
});
afterEach(async () => {
  client.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

it('enrolls once, sends only scoped heartbeat authorization, exposes no secret', async () => {
  await client.redeem(token);
  await client.heartbeat();
  expect(client.state).toBe('active');
  expect(client.connector?.deviceId).toBe(binding.deviceId);
  expect(calls.map((req) => req.url)).toEqual([
    '/api/v1/local-machine/connectors/redemption',
    '/api/v1/local-machine/connectors/heartbeat',
  ]);
  expect(calls[0].headers.authorization).toBeUndefined();
  expect(calls[1].headers.authorization).toBe(`Bearer ${credential}`);
  for (const req of calls) {
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers.forwarded).toBeUndefined();
  }
  expect(JSON.stringify(client)).not.toContain(credential);
  const metadata = client.connector!;
  metadata.deviceId = binding.tenantId;
  expect(client.connector?.deviceId).toBe(binding.deviceId);
  await expect(client.redeem(token)).rejects.toThrow('Enrollment unavailable');
});

it.each([
  'http://localhost:3001',
  'https://127.0.0.1:3001',
  'http://127.0.0.1',
  'http://127.0.0.1:3001/path',
  'http://user:pass@127.0.0.1:3001',
  'http://127.0.0.1:3001/?secret=yes',
  'http://example.com:3001',
])('rejects endpoint %s', (url) => {
  expect(
    () =>
      new LocalConnectorClient({ mode: 'local_test', baseUrl: url, binding }),
  ).toThrow();
});
it('rejects production and invalid timeout or binding', () => {
  expect(
    () =>
      new LocalConnectorClient({
        mode: 'local_test',
        baseUrl,
        binding,
        timeoutMs: 0,
      }),
  ).toThrow();
  expect(
    () =>
      new LocalConnectorClient({
        mode: 'local_test',
        baseUrl,
        binding: { ...binding, tenantId: 'bad' },
      }),
  ).toThrow();
  vi.stubEnv('NODE_ENV', 'production');
  expect(
    () => new LocalConnectorClient({ mode: 'local_test', baseUrl, binding }),
  ).toThrow();
});
it('rejects invalid token before dispatch', async () => {
  await expect(client.redeem(credential)).rejects.toThrow(
    'Invalid enrollment token',
  );
  expect(client.state).toBe('idle');
  expect(calls).toHaveLength(0);
});
it.each([
  'lost',
  'timeout',
  'redirect',
  'oversize',
  'malformed',
  'wrong_binding',
  'denied',
])('never retries uncertain redemption: %s', async (kind) => {
  handler = (req, res) => {
    if (kind === 'lost') req.socket.destroy();
    if (kind === 'timeout') return;
    if (kind === 'redirect') {
      res.writeHead(307, { location: 'http://example.com' });
      res.end();
    }
    if (kind === 'oversize') {
      res.writeHead(201);
      res.end('a'.repeat(17000));
    }
    if (kind === 'malformed') {
      res.writeHead(201);
      res.end(token);
    }
    if (kind === 'wrong_binding')
      reply(res, 201, {
        connector: { ...record(), deviceId: binding.tenantId },
        credential,
      });
    if (kind === 'denied') reply(res, 403, { secret: token });
  };
  await expect(client.redeem(token)).rejects.toThrow(
    'Enrollment not confirmed',
  );
  expect(client.state).toBe('uncertain');
  expect(client.connector).toBeNull();
  await expect(client.redeem(token)).rejects.toThrow('Enrollment unavailable');
  expect(calls).toHaveLength(1);
});
it('allows explicit heartbeat retry after outage, but not concurrent calls', async () => {
  await client.redeem(token);
  let release!: () => void;
  handler = (_, res) => {
    release = () => reply(res, 503, { secret: credential });
  };
  const pending = client.heartbeat();
  // Wait for server request, not a guessed scheduling delay.
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await expect(client.heartbeat()).rejects.toThrow('Heartbeat unavailable');
  release();
  await expect(pending).rejects.toThrow('Heartbeat not confirmed');
  expect(client.state).toBe('active');
  handler = (_, res) => reply(res, 200, { connector: record() });
  await client.heartbeat();
});
it.each([401, 403, 404])(
  'clears authorization on heartbeat %s',
  async (status) => {
    await client.redeem(token);
    handler = (_, res) => reply(res, status, { secret: credential });
    await expect(client.heartbeat()).rejects.toThrow('Heartbeat not confirmed');
    expect(client.state).toBe('denied');
    expect(client.connector).toBeNull();
    await expect(client.heartbeat()).rejects.toThrow('Heartbeat unavailable');
  },
);
it.each(['identity', 'lifetime'])(
  'fails closed on switched connector %s',
  async (change) => {
    await client.redeem(token);
    handler = (_, res) =>
      reply(res, 200, {
        connector: {
          ...record(),
          ...(change === 'identity'
            ? { id: binding.tenantId }
            : {
                createdAt: new Date(createdAt.getTime() - 1000).toISOString(),
                expiresAt: new Date(
                  createdAt.getTime() + 2591999000,
                ).toISOString(),
              }),
        },
      });
    await expect(client.heartbeat()).rejects.toThrow();
    expect(client.state).toBe('denied');
  },
);
it('expires locally without dispatch', async () => {
  await client.redeem(token);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2592000000);
  try {
    await expect(client.heartbeat()).rejects.toThrow(
      'Connector authorization ended',
    );
    expect(calls).toHaveLength(1);
    expect(client.state).toBe('denied');
  } finally {
    vi.restoreAllMocks();
  }
});
it('stop cancels pending enrollment and never accepts late credentials', async () => {
  handler = () => {};
  const pending = client.redeem(token);
  client.stop();
  await expect(pending).rejects.toThrow('Enrollment not confirmed');
  expect(client.state).toBe('stopped');
  expect(client.connector).toBeNull();
  await expect(client.heartbeat()).rejects.toThrow('Heartbeat unavailable');
});
