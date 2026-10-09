import { afterEach, expect, it, vi } from 'vitest';
import { MachineService } from './machine-service';
import { LocalMachineAuthority } from './local-machine-authority';
import { SyntheticAttendanceInbox } from './synthetic-inbox';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const configure = () => {
  vi.stubEnv('CONNECTOR_HTTP_MODE', 'local_test');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_HOST', '127.0.0.1');
  vi.stubEnv('DATABASE_URL', 'postgresql://test@127.0.0.1:55432/kinto_test');
  vi.stubEnv('CONNECTOR_REDIS_URL', 'redis://127.0.0.1:56379/2');
  vi.stubEnv('CONNECTOR_NAMESPACE', '00000000-0000-4000-8000-000000000001');
};
it('leaves disabled mode inert and refuses admission without starting dependencies', async () => {
  vi.stubEnv('CONNECTOR_HTTP_MODE', 'disabled');
  const connect = vi.spyOn(LocalMachineAuthority.prototype, 'connect');
  const service = new MachineService();
  await service.onModuleInit();
  await service.ready();
  expect(connect).not.toHaveBeenCalled();
  expect(() => service.enabled()).toThrow();
  await expect(service.limit('127.0.0.1')).rejects.toMatchObject({
    status: 404,
  });
  await service.onModuleDestroy();
});
it('closes failed startup and does not retain a half-connected authority', async () => {
  configure();
  vi.spyOn(LocalMachineAuthority.prototype, 'connect').mockRejectedValue(
    new Error('private store failure'),
  );
  const close = vi.spyOn(LocalMachineAuthority.prototype, 'close');
  const service = new MachineService();
  await expect(service.onModuleInit()).rejects.toThrow(
    'Connector admission dependencies unavailable',
  );
  expect(close).toHaveBeenCalledOnce();
  await expect(service.ready()).rejects.toMatchObject({ status: 503 });
});
it('shares atomic address limits and reports admission dependency failure without fallback', async () => {
  configure();
  vi.spyOn(LocalMachineAuthority.prototype, 'connect').mockResolvedValue();
  vi.spyOn(SyntheticAttendanceInbox.prototype, 'ready').mockResolvedValue();
  const allow = vi
    .spyOn(LocalMachineAuthority.prototype, 'allow')
    .mockResolvedValue(true);
  const ready = vi
    .spyOn(LocalMachineAuthority.prototype, 'ready')
    .mockResolvedValue();
  const service = new MachineService();
  await service.onModuleInit();
  await service.ready();
  expect(ready).toHaveBeenCalledOnce();
  await service.limit('127.0.0.1');
  expect(allow).toHaveBeenCalledWith('127.0.0.1');
  allow.mockResolvedValue(false);
  await expect(service.limit('127.0.0.1')).rejects.toMatchObject({
    status: 429,
  });
  allow.mockRejectedValue(new Error('private store failure'));
  await expect(service.limit('127.0.0.1')).rejects.toMatchObject({
    status: 503,
  });
  await service.onModuleDestroy();
});

it('cleans both dependencies on review startup failure and clears them on shutdown', async () => {
  configure();
  vi.spyOn(LocalMachineAuthority.prototype, 'connect').mockResolvedValue();
  const ready = vi
    .spyOn(SyntheticAttendanceInbox.prototype, 'ready')
    .mockRejectedValue(new Error('private failure'));
  const close = vi
    .spyOn(SyntheticAttendanceInbox.prototype, 'close')
    .mockResolvedValue();
  const authorityClose = vi
    .spyOn(LocalMachineAuthority.prototype, 'close')
    .mockResolvedValue();
  const service = new MachineService();
  await expect(service.onModuleInit()).rejects.toThrow(
    'Connector admission dependencies unavailable',
  );
  expect(close).toHaveBeenCalledOnce();
  expect(authorityClose).toHaveBeenCalledOnce();
  expect(() =>
    service.reviewInbox(
      { identityId: 'unused', mfaVerified: true },
      'unused',
      'unused',
      {},
    ),
  ).toThrow();
  ready.mockResolvedValue();
  vi.spyOn(LocalMachineAuthority.prototype, 'ready').mockResolvedValue();
  await service.onModuleInit();
  await service.ready();
  ready.mockRejectedValue(new Error('private failure'));
  await expect(service.ready()).rejects.toThrow('private failure');
  await service.onModuleDestroy();
  await expect(service.ready()).rejects.toMatchObject({ status: 503 });
  await service.onModuleDestroy();
  expect(close).toHaveBeenCalledTimes(2);
});
