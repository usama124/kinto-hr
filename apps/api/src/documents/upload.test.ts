import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { type DatabaseService } from '../database.service';
import {
  DocumentUploadService,
  matchesDocumentSignature,
  readDocumentBytes,
  readDocumentUploadConfig,
} from './upload';

const pdf = Buffer.from('%PDF-1.7\nSynthetic PDF\n%%EOF');
const tenantId = randomUUID();
const employeeId = randomUUID();
const documentId = randomUUID();
const actor = { identityId: randomUUID(), mfaVerified: true };
const key = `ab/${randomUUID()}`;
const target = {
  storageObjectKey: key,
  contentType: 'application/pdf' as const,
  sizeBytes: pdf.length,
  fileDigest: createHash('sha256').update(pdf).digest('hex'),
  status: 'awaiting_upload' as const,
};
const request = (bytes: Buffer) => ({
  headers: {
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
  },
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
});
let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

async function scanner(verdict: string) {
  server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      const stream = Buffer.concat(chunks);
      expect(stream.subarray(0, 10).toString()).toBe('zINSTREAM\0');
      socket.end(`${verdict}\0`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Invalid scanner');
  return address.port;
}

it('keeps local upload storage disabled by default and rejects production use', () => {
  expect(readDocumentUploadConfig({})).toBeUndefined();
  expect(() =>
    readDocumentUploadConfig({
      DOCUMENT_STORAGE_MODE: 'local_test',
      NODE_ENV: 'production',
    }),
  ).toThrow();
  expect(() =>
    readDocumentUploadConfig({
      DOCUMENT_STORAGE_MODE: 'local_test',
      DOCUMENT_CLAMD_HOST: 'scanner.example',
    }),
  ).toThrow();
});

it('checks exact bytes and signatures before scanning', async () => {
  expect(matchesDocumentSignature(pdf, 'application/pdf')).toBe(true);
  expect(matchesDocumentSignature(pdf, 'image/png')).toBe(false);
  expect(
    matchesDocumentSignature(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      'image/jpeg',
    ),
  ).toBe(true);
  expect(
    matchesDocumentSignature(
      Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
      ]),
      'image/png',
    ),
  ).toBe(true);
  expect(await readDocumentBytes(request(pdf), pdf.length)).toEqual(pdf);
  await expect(
    readDocumentBytes(request(pdf), pdf.length + 1),
  ).rejects.toThrow();
});

it('stores quarantine bytes and marks clean only after a scanner verdict', async () => {
  const port = await scanner('stream: OK');
  directory = await mkdtemp(join(tmpdir(), 'kinto-document-test-'));
  vi.stubEnv('DOCUMENT_STORAGE_MODE', 'local_test');
  vi.stubEnv('DOCUMENT_QUARANTINE_DIR', directory);
  vi.stubEnv('DOCUMENT_CLAMD_PORT', String(port));
  const transitions: string[] = [];
  const database = {
    authorizeEmployeeDocumentUpload: vi.fn().mockResolvedValue(target),
    authorizeEmployeeDocumentDownload: vi.fn().mockResolvedValue({
      storageObjectKey: key,
      contentType: target.contentType,
      sizeBytes: target.sizeBytes,
      fileDigest: target.fileDigest,
    }),
    transitionEmployeeDocumentScan: vi
      .fn()
      .mockImplementation(
        async (_actor, _tenant, _employee, _document, _from, to) => {
          transitions.push(to);
          return { id: documentId, status: to };
        },
      ),
  };
  const service = new DocumentUploadService(
    database as unknown as DatabaseService,
  );
  expect(
    await service.upload(actor, tenantId, employeeId, documentId, request(pdf)),
  ).toEqual({ id: documentId, status: 'clean' });
  expect(transitions).toEqual(['quarantined', 'clean']);
  expect(await readFile(join(directory, tenantId, key))).toEqual(pdf);
  expect(
    await service.download(actor, tenantId, employeeId, documentId),
  ).toEqual({
    bytes: pdf,
    contentType: 'application/pdf',
  });
  await writeFile(join(directory, tenantId, key), Buffer.alloc(pdf.length));
  await expect(
    service.download(actor, tenantId, employeeId, documentId),
  ).rejects.toThrow('Private document unavailable');
});

it('keeps scanner outages quarantined and rejects infected bytes', async () => {
  directory = await mkdtemp(join(tmpdir(), 'kinto-document-test-'));
  vi.stubEnv('DOCUMENT_STORAGE_MODE', 'local_test');
  vi.stubEnv('DOCUMENT_QUARANTINE_DIR', directory);
  vi.stubEnv('DOCUMENT_CLAMD_PORT', '65432');
  const transitions: string[] = [];
  const database = {
    authorizeEmployeeDocumentUpload: vi.fn().mockResolvedValue(target),
    transitionEmployeeDocumentScan: vi
      .fn()
      .mockImplementation(
        async (_actor, _tenant, _employee, _document, _from, to) => {
          transitions.push(to);
          return { id: documentId, status: to };
        },
      ),
  };
  const service = new DocumentUploadService(
    database as unknown as DatabaseService,
  );
  await expect(
    service.upload(actor, tenantId, employeeId, documentId, request(pdf)),
  ).rejects.toThrow('Document scan unavailable');
  expect(transitions).toEqual(['quarantined']);
  const port = await scanner('stream: Eicar-Test-Signature FOUND');
  vi.stubEnv('DOCUMENT_CLAMD_PORT', String(port));
  const retry = new DocumentUploadService(
    database as unknown as DatabaseService,
  );
  database.authorizeEmployeeDocumentUpload.mockResolvedValueOnce({
    ...target,
    status: 'quarantined',
  });
  expect(
    await retry.upload(actor, tenantId, employeeId, documentId, request(pdf)),
  ).toEqual({ id: documentId, status: 'rejected' });
  expect(transitions).toEqual(['quarantined', 'rejected']);
  await expect(readFile(join(directory, tenantId, key))).rejects.toThrow();
});
