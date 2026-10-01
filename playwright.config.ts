import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4310);

// E2E runs the production build served by the API on :4310 against the local database,
// after re-seeding the fictional DEMO tenant (see e2e/global-setup.ts).
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `npm run build && PORT=${PORT} NODE_ENV=production npx tsx server/src/main.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LOG_SILENT: '1', LOGIN_RATE_LIMIT: '1000', PUBLIC_URL: `http://127.0.0.1:${PORT}` },
  },
});
