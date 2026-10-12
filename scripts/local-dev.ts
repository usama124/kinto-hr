import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localEnv } from './lib/local-auth';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const env = localEnv(await readFile('.env', 'utf8'));
if (
  env.AUTH_MODE !== 'oidc' ||
  env.AUTH_ORIGIN !== 'https://localhost:3443' ||
  !/^http:\/\/localhost:8080\/realms\/kinto_local_[a-f0-9]{32}$/.test(
    env.OIDC_ISSUER ?? '',
  )
)
  throw new Error(
    'Run local:auth:setup before starting local authenticated development',
  );

// Never proxy an unrelated existing application, or let Next silently move to
// another port while this proxy continues sending requests to the old one.
for (const port of [
  3000,
  4000,
  3443,
  Number(env.WORKER_MONITOR_PORT ?? '9464'),
]) {
  const probe = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', () =>
      reject(
        new Error(
          `Local port ${port} is already in use; stop the previous Kinto dev session first.`,
        ),
      ),
    );
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log('Waiting for the configured local Keycloak realm…');
const providerDeadline = Date.now() + 120000;
let providerReady = false;
while (Date.now() < providerDeadline) {
  providerReady = await fetch(
    `${env.OIDC_ISSUER}/.well-known/openid-configuration`,
    {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    },
  )
    .then((response) => response.ok)
    .catch(() => false);
  if (providerReady) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!providerReady)
  throw new Error(
    'Local Keycloak is unavailable. Run pnpm local:auth:up, then retry.',
  );

const server = createServer(
  {
    key: await readFile('.local/auth/key.pem'),
    cert: await readFile('.local/auth/cert.pem'),
  },
  (req, res) => {
    if (req.headers.host !== 'localhost:3443') {
      res.writeHead(400).end('Use https://localhost:3443');
      return;
    }
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: req.url?.startsWith('/api/') ? 4000 : 3000,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Local application is starting or unavailable.');
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  },
);
// Next development refresh uses WebSockets. Forward only to the fixed local web
// listener; no arbitrary destination, forwarding trust or TLS bypass is added.
server.on('upgrade', (req, socket, head) => {
  if (req.headers.host !== 'localhost:3443') return socket.destroy();
  const upstream = connect(3000, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    upstream.write('\r\n');
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(3443, '127.0.0.1', resolve);
});
const application = spawn('pnpm', ['dev'], {
  cwd: process.cwd(),
  env: { ...process.env, ...env, PORT: '3000' },
  detached: true,
  stdio: 'inherit',
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void readFile('.local/auth/application.pid', 'utf8')
    .then((pid) => {
      if (pid.trim() === String(process.pid))
        return unlink('.local/auth/application.pid');
    })
    .catch(() => {});
  if (application.pid) {
    try {
      process.kill(-application.pid, 'SIGTERM');
    } catch {
      // The owned process group may already have exited.
    }
  }
  server.closeAllConnections();
  server.close();
  // Bound graceful shutdown even when a dev watcher/WebSocket does not exit.
  const deadline = setTimeout(() => {
    if (application.pid) {
      try {
        process.kill(-application.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    process.exit(process.exitCode ?? 0);
  }, 8000);
  deadline.unref();
}
application.on('error', () => {
  console.error(
    'Local application could not start. Check Node/pnpm and local ports.',
  );
  process.exitCode = 1;
  stop();
});
application.on('exit', (code) => {
  if (!stopping) process.exitCode = code ?? 1;
  stop();
});
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await writeFile('.local/auth/application.pid', `${process.pid}\n`, {
  mode: 0o600,
});
console.log('Starting Kinto API, web and worker…');
const applicationDeadline = Date.now() + 30000;
let applicationReady = false;
while (!stopping && Date.now() < applicationDeadline) {
  const results = await Promise.all([
    fetch('http://127.0.0.1:4000/api/v1/health/ready', {
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => response.ok)
      .catch(() => false),
    fetch('http://127.0.0.1:3000/login', { signal: AbortSignal.timeout(2000) })
      .then((response) => response.ok)
      .catch(() => false),
  ]);
  applicationReady = results.every(Boolean);
  if (applicationReady) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!applicationReady) {
  if (!stopping) {
    console.error(
      'Kinto did not become ready. Check private local logs and database/Redis availability.',
    );
    process.exitCode = 1;
    stop();
  }
} else {
  console.log('Kinto local login: https://localhost:3443/login');
  console.log(
    'Local email inbox: http://127.0.0.1:8025 — mail never leaves this machine.',
  );
  console.log(
    'Accept the localhost certificate warning once; Secure cookies remain enabled.',
  );
}
