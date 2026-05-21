import { defineConfig, devices } from '@playwright/test';

// Playwright configuration.
// Task 0 keeps this minimal; Task 6+ add real specs that drive the
// full Create-Collection / Insert / Search smoke flow.
// When ``E2E_RECORD=1`` is set (used by the ``e2e:record`` script for
// Review-node deliverables), trace + video + screenshot are always kept
// regardless of pass/fail so reviewers can inspect the happy path.
const RECORD = process.env.E2E_RECORD === '1';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../artifacts/playwright-report', open: 'never' }],
    ['junit', { outputFile: '../../artifacts/playwright-junit.xml' }],
  ],
  outputDir: '../../artifacts/playwright-test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: RECORD ? 'on' : 'retain-on-failure',
    screenshot: RECORD ? 'on' : 'only-on-failure',
    video: RECORD ? 'on' : 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Boot Vite's dev server so specs can load the real SPA. The backend is
  // intentionally NOT started -- each spec mocks the API via ``page.route``
  // so the smoke flow can't be perturbed by the developer's local state.
  webServer: {
    command: 'pnpm dev -- --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
