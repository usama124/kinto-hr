import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  BadRequestException,
  Injectable,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type EmployeeDocumentUploadTarget } from '@kinto/contracts';
import { DatabaseService } from '../database.service';

const MAX_BYTES = 10 * 1024 * 1024;
type UploadRequest = AsyncIterable<Uint8Array> & {
  headers: Record<string, string | string[] | undefined>;
};
type Actor = { identityId: string; mfaVerified: boolean };

export function readDocumentUploadConfig(env: NodeJS.ProcessEnv) {
  const mode = env.DOCUMENT_STORAGE_MODE ?? 'disabled';
  if (mode === 'disabled') return undefined;
  if (mode !== 'local_test' || env.NODE_ENV === 'production')
    throw new Error('Document upload storage is not configured for production');
  const root = env.DOCUMENT_QUARANTINE_DIR ?? resolve('.local/documents');
  const host = env.DOCUMENT_CLAMD_HOST ?? '127.0.0.1';
  const port = Number(env.DOCUMENT_CLAMD_PORT ?? '3310');
  if (!isAbsolute(root) || !['127.0.0.1', 'localhost'].includes(host))
    throw new Error(
      'Local document services must use private paths and loopback',
    );
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid local document scanner port');
  return { root, host, port };
}

export function matchesDocumentSignature(
  bytes: Buffer,
  contentType: EmployeeDocumentUploadTarget['contentType'],
) {
  if (contentType === 'application/pdf')
    return (
      bytes.length >= 10 &&
      bytes.subarray(0, 5).toString() === '%PDF-' &&
      bytes.subarray(-5).toString() === '%%EOF'
    );
  if (contentType === 'image/jpeg')
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9
    );
  return (
    bytes.length >= 20 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes
      .subarray(-12)
      .equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
  );
}

export async function readDocumentBytes(
  request: UploadRequest,
  expectedSize: number,
) {
  if (request.headers['content-type'] !== 'application/octet-stream')
    throw new BadRequestException();
  const declared = request.headers['content-length'];
  if (typeof declared !== 'string' || !/^\d+$/.test(declared))
    throw new BadRequestException();
  if (Number(declared) !== expectedSize || expectedSize > MAX_BYTES)
    throw new BadRequestException();
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > expectedSize) throw new BadRequestException();
    chunks.push(Buffer.from(chunk));
  }
  if (received !== expectedSize) throw new BadRequestException();
  return Buffer.concat(chunks, received);
}

export async function scanWithClamd(
  bytes: Buffer,
  host: string,
  port: number,
): Promise<'clean' | 'infected'> {
  return new Promise((resolveScan, rejectScan) => {
    const socket = createConnection({ host, port });
    let answer = '';
    let settled = false;
    const finish = (result: 'clean' | 'infected' | Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) rejectScan(result);
      else resolveScan(result);
    };
    socket.setTimeout(10_000, () => finish(new Error('Scanner timed out')));
    socket.on('error', () => finish(new Error('Scanner unavailable')));
    socket.on('close', () => {
      if (!settled) finish(new Error('Scanner ended without a verdict'));
    });
    socket.on('data', (chunk: Buffer) => {
      answer += chunk.toString('utf8');
      if (answer.length > 256)
        return finish(new Error('Scanner response too large'));
      if (!answer.includes('\0')) return;
      const verdict = answer.split('\0')[0];
      if (verdict === 'stream: OK') finish('clean');
      else if (/^stream: .+ FOUND$/.test(verdict)) finish('infected');
      else finish(new Error('Scanner returned no valid verdict'));
    });
    socket.on('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  });
}

async function storeQuarantine(
  root: string,
  tenantId: string,
  key: string,
  bytes: Buffer,
) {
  const location = join(root, tenantId, key);
  await mkdir(dirname(location), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(
      location,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close();
      await unlink(location).catch(() => undefined);
      throw error;
    }
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const current = await stat(location);
    if (!current.isFile() || current.size !== bytes.length)
      throw new Error('Quarantine object conflicts with registered file', {
        cause: error,
      });
    const existing = await readFile(location);
    if (!existing.equals(bytes))
      throw new Error('Quarantine object conflicts with registered file', {
        cause: error,
      });
  }
  return location;
}

@Injectable()
export class DocumentUploadService {
  private readonly config = readDocumentUploadConfig(process.env);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async upload(
    actor: Actor,
    tenantId: string,
    employeeId: string,
    documentId: string,
    request: UploadRequest,
  ) {
    if (!this.config)
      throw new ServiceUnavailableException('Document upload unavailable');
    const target = await this.database.authorizeEmployeeDocumentUpload(
      actor,
      tenantId,
      employeeId,
      documentId,
    );
    const bytes = await readDocumentBytes(request, target.sizeBytes);
    if (
      createHash('sha256').update(bytes).digest('hex') !== target.fileDigest ||
      !matchesDocumentSignature(bytes, target.contentType)
    )
      throw new BadRequestException();
    const location = await storeQuarantine(
      this.config.root,
      tenantId,
      target.storageObjectKey,
      bytes,
    );
    if (target.status === 'awaiting_upload')
      await this.database.transitionEmployeeDocumentScan(
        actor,
        tenantId,
        employeeId,
        documentId,
        'awaiting_upload',
        'quarantined',
      );
    let verdict: 'clean' | 'infected';
    try {
      verdict = await scanWithClamd(bytes, this.config.host, this.config.port);
    } catch {
      throw new ServiceUnavailableException('Document scan unavailable');
    }
    const document = await this.database.transitionEmployeeDocumentScan(
      actor,
      tenantId,
      employeeId,
      documentId,
      'quarantined',
      verdict === 'clean' ? 'clean' : 'rejected',
    );
    if (verdict === 'infected') await unlink(location);
    return document;
  }
}
