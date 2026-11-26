import { expect, test } from '@playwright/test';

// Runs against the real stack (see playwright.smoke.config.ts), not the mocked backend: the page served by
// message-persistence with its real Content-Security-Policy, config, chat history and public stream.
// Signing in needs a real Google account and is not covered here.
test('the packaged frontend boots against the real backend', async ({ page, request }) => {
  const problems: string[] = [];
  // Google's own sign-in library may complain (unauthorized origin, offline CI); anything else must be clean.
  const google = /accounts\.google\.com|GSI_LOGGER|gsi\/client/i;
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (google.test(msg.text()) || google.test(msg.location().url)) return;
    problems.push(`console.error: ${msg.text()} (${msg.location().url})`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));

  const history = await request.get('/api/chat/history?limit=100');
  expect(history.ok()).toBe(true);
  const events = (await history.json()) as Array<{ messageId: string }>;
  const distinct = new Set(events.map((e) => e.messageId)).size;

  await page.goto('/');
  await expect(page).toHaveTitle(/chat/i);
  await expect(page.locator('#conn')).toHaveText(/^live/);
  // one line per distinct history entry; messages posted meanwhile may add more, never fewer
  await expect.poll(() => page.locator('#lines .line').count()).toBeGreaterThanOrEqual(distinct);
  await expect(page.locator('#text')).toBeDisabled();
  await expect(page.locator('#me')).toBeHidden();

  // the theme script and the hashed bundle both loaded under the CSP
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
  expect(problems).toEqual([]);
});
