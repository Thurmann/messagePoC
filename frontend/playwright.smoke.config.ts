import { defineConfig, devices } from '@playwright/test';

// Runs against a real stack (docker compose up, message-persistence on :8083), not the mocked backend.
// SMOKE_BASE_URL overrides the address.
export default defineConfig({
  testDir: 'e2e/smoke',
  outputDir: 'build/playwright/smoke-results',
  reporter: [['list']],
  retries: 0,
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? 'http://localhost:8083',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
