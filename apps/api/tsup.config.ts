import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node22',
  clean: true,
  noExternal: [/^@kinto\//],
  external: ['@prisma/client'],
});
