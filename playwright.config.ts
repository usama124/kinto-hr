import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      // Start the actual bundle without pnpm's inherited module lookup paths.
      command: 'node apps/api/dist/main.cjs',
      env: { NODE_PATH: '' },
      url: 'http://127.0.0.1:4000/api/v1/health/ready',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'pnpm --filter @kinto/web start',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
