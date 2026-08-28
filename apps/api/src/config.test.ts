import { expect, it } from 'vitest';
import { readConfig } from './config';
it('requires an explicit PostgreSQL runtime URL', () => {
  expect(() => readConfig({})).toThrow();
  expect(() => readConfig({ DATABASE_URL: 'https://example.com' })).toThrow();
  expect(
    readConfig({ DATABASE_URL: 'postgresql://localhost/kinto_test' }),
  ).toEqual({
    databaseUrl: 'postgresql://localhost/kinto_test',
    port: 4000,
    host: '127.0.0.1',
  });
});
it('validates port and listen host', () => {
  expect(
    readConfig({
      DATABASE_URL: 'postgres://localhost/kinto_test',
      API_PORT: '4010',
      API_HOST: '0.0.0.0',
    }).port,
  ).toBe(4010);
  expect(() =>
    readConfig({
      DATABASE_URL: 'postgres://localhost/kinto_test',
      API_PORT: '0',
    }),
  ).toThrow();
  expect(() =>
    readConfig({
      DATABASE_URL: 'postgres://localhost/kinto_test',
      API_HOST: 'untrusted',
    }),
  ).toThrow();
});
