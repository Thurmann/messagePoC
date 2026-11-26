import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

// The app is served by `vite preview` with the production Content-Security-Policy (see vite.config.ts),
// so a CSP violation fails a test. Run `npm run build` first; the Gradle task e2eTest does.
export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'smoke/**',
  outputDir: 'build/playwright/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'build/playwright/report', open: 'never' }],
    ['junit', { outputFile: 'build/test-results/e2e/junit.xml' }],
  ],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js preview`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
