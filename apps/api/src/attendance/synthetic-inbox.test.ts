import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyntheticAttendanceInbox } from './synthetic-inbox';
describe('synthetic inbox configuration', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('rejects production and remote or ordinary databases before connecting', () => {
    for (const url of [
      'postgres://user:pass@remote.example/kinto_test',
      'postgres://user:pass@localhost/kinto',
      'https://localhost/kinto_test',
      'postgres://user:pass@localhost/kinto_test-bypass',
    ])
      expect(() => new SyntheticAttendanceInbox(url)).toThrow(
        'Synthetic attendance inbox requires',
      );
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      () =>
        new SyntheticAttendanceInbox(
          'postgres://user:pass@localhost/kinto_test',
        ),
    ).toThrow('Synthetic attendance inbox requires');
  });
});
