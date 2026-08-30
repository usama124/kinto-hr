import { createServer as createTcpServer, type Server } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Local listener unavailable');
  return address.port;
}
export async function close(server: Server) {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
export async function freePort() {
  const server = createTcpServer();
  const port = await listen(server);
  await close(server);
  return port;
}
export async function until(check: () => Promise<boolean>, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Local fixture timed out');
}
// Test-only SMTP sink, bound to loopback. No forwarding, credentials or external
// delivery. A real production email service is not implemented by this fixture.
export async function mailSink() {
  const messages: string[] = [];
  const server = createTcpServer((socket) => {
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('error', () => {});
    socket.write('220 localhost ESMTP test sink\r\n');
    let buffer = '';
    let data: string[] | undefined;
    let dataBytes = 0;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return socket.destroy();
      for (let offset; (offset = buffer.indexOf('\r\n')) >= 0;) {
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        if (data) {
          if (line === '.') {
            messages.push(data.join('\r\n'));
            data = undefined;
            socket.write('250 Message captured\r\n');
          } else {
            dataBytes += Buffer.byteLength(line) + 2;
            if (dataBytes > 1024 * 1024) return socket.destroy();
            data.push(line.replace(/^\.\./, '.'));
          }
        } else if (/^(EHLO|HELO)/i.test(line))
          socket.write('250-localhost\r\n250 8BITMIME\r\n');
        else if (/^DATA$/i.test(line)) {
          data = [];
          dataBytes = 0;
          socket.write('354 End with dot\r\n');
        } else if (/^QUIT$/i.test(line)) socket.end('221 Bye\r\n');
        else if (/^(MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line))
          socket.write('250 OK\r\n');
        else socket.write('502 Unsupported\r\n');
      }
    });
  });
  const port = await listen(server);
  return { server, port, messages };
}
export function resetLink(message: string, issuer: string) {
  const decoded = message
    .replace(/=\r\n/g, '')
    .replace(/=([A-Fa-f0-9]{2})/g, (_, value: string) =>
      String.fromCharCode(parseInt(value, 16)),
    )
    .replaceAll('&amp;', '&');
  const links = decoded.match(/https?:\/\/[^\s<>"\r\n]+/g) ?? [];
  const result = links.find((link) =>
    link.startsWith(`${issuer}/login-actions/action-token?`),
  );
  if (!result)
    throw new Error(
      'Reset email did not contain the expected local action link',
    );
  return result;
}
export function totp(secret: string | Buffer) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac(
    'sha1',
    Buffer.isBuffer(secret) ? secret : Buffer.from(secret),
  )
    .update(counter)
    .digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
}
export async function httpsProxy(
  directory: string,
  apiPort: number,
  webPort: number,
) {
  const server = createHttpsServer(
    {
      key: await readFile(`${directory}/key.pem`),
      cert: await readFile(`${directory}/cert.pem`),
    },
    (req, res) => {
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: req.url?.startsWith('/api/') ? apiPort : webPort,
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
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    },
  );
  const port = await listen(server);
  return { server, origin: `https://localhost:${port}` };
}
