import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
if (existsSync('.env')) process.loadEnvFile('.env');
const webPort = process.env.E2E_WEB_PORT || '3000';
if (!/^\d{2,5}$/.test(webPort)) throw new Error('Invalid E2E_WEB_PORT');
const webUrl = `http://127.0.0.1:${webPort}`;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webUrl,
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
      command: `pnpm --filter @kinto/web start --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
