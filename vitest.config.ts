import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'apps/worker/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/domain/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'apps/api/src/config.ts',
        'apps/api/src/auth/config.ts',
        'apps/worker/src/config.ts',
      ],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
