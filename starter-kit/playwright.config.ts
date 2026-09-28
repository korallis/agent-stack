import { defineConfig, devices } from '@playwright/test';

// Acceptance journeys: a person using the running app, on a desktop and on a phone.
// Each seat serves the app on its own port (E2E_PORT, set per seat by agent-stack's env.sh) so parallel seats never
// test each other's servers. E2E_BASE_URL / E2E_START_COMMAND let the merge owner point the held-out suite at an app.
const port = process.env.E2E_PORT ?? process.env.PORT ?? '3000';
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

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
        env: { PORT: port },
        // Never reuse a server this run did not start: an occupied port fails loudly instead of testing someone else's app.
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
