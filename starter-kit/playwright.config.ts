import { defineConfig, devices } from '@playwright/test';

// Acceptance journeys: a person using the running app, on a desktop and on a phone.
// E2E_BASE_URL / E2E_START_COMMAND let the merge owner point the held-out suite at the same app.
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: process.env.E2E_TEST_DIR ?? 'tests/acceptance',
  testIgnore: ['**/fixtures/**'],
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.E2E_START_COMMAND ?? 'npm run start:test',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
