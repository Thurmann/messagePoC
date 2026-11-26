import { expect, T0, test } from './support/fixtures';

const HOUR = 3_600_000;
// page.clock stands still at this time while a spec runs; ban deadlines are computed from it
const NOW = T0 + 1000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const banned = (seconds: number) => ({ until: iso(seconds * 1000), remainingSeconds: seconds });

test.describe('temporary ban', () => {
  test('counts down, blocks the composer and lifts itself', async ({ page, app }) => {
    await app.openWithClock();
    await app.signIn({ ban: banned(65), strikes: 3, warning: true });

    const banner = page.locator('#ban-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('You are temporarily banned from posting. Time remaining: 1m 5s');
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(page.locator('#warn-banner')).toBeHidden(); // the ban supersedes the warning
    await expect(page.locator('#text')).toBeDisabled();
    await expect(page.locator('#send')).toBeDisabled();
    await expect(page.locator('#text')).toHaveAttribute('placeholder', 'You are temporarily banned');

    await page.clock.runFor(1000);
    await expect(banner).toHaveText('You are temporarily banned from posting. Time remaining: 1m 4s');
    await page.clock.runFor(4000);
    await expect(banner).toHaveText('You are temporarily banned from posting. Time remaining: 1m 0s');
    await page.clock.runFor(53_000);
    await expect(banner).toHaveText('You are temporarily banned from posting. Time remaining: 7s');

    await page.clock.runFor(7000);
    await expect(banner).toBeHidden();
    await expect(page.locator('#text')).toBeEnabled();
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#text')).toHaveAttribute('placeholder', 'Write a message');
  });

  test('long bans show hours', async ({ page, app }) => {
    await app.openWithClock();
    await app.signIn({ ban: { until: iso(HOUR + 5000), remainingSeconds: 3605 } });
    await expect(page.locator('#ban-banner')).toHaveText(
      'You are temporarily banned from posting. Time remaining: 1h 0m 5s',
    );
  });

  test('without a deadline the remaining seconds are used', async ({ page, app }) => {
    await app.openWithClock();
    await app.signIn({ ban: { until: 'not a date', remainingSeconds: 120 } });
    await expect(page.locator('#ban-banner')).toHaveText(
      'You are temporarily banned from posting. Time remaining: 2m 0s',
    );
  });

  test('a rejected POST with BANNED starts the countdown and keeps the text', async ({ page, app, api }) => {
    await app.openWithClock();
    await app.signIn();
    api.on('POST /api/messages', () => ({
      status: 403,
      json: { error: 'BANNED', bannedUntil: iso(120_000), remainingSeconds: 120 },
      headers: { 'Retry-After': '120' },
    }));
    await app.send('one more');

    await expect(page.locator('#ban-banner')).toHaveText(
      'You are temporarily banned from posting. Time remaining: 2m 0s',
    );
    await expect(page.locator('#text')).toBeDisabled();
    await expect(page.locator('#text')).toHaveValue('one more');
    await expect(page.locator('#send-error')).toBeHidden();
    await expect(page.locator('#lines .line', { hasText: 'one more' })).toHaveCount(0);

    await page.clock.runFor(121_000);
    await expect(page.locator('#ban-banner')).toBeHidden();
    await expect(page.locator('#text')).toBeEnabled();
  });

  test('a ban reported by the presence heartbeat is shown', async ({ page, app, api }) => {
    api.on('POST /api/me/presence', () => ({ json: { ban: banned(90) } }));
    await app.openWithClock();
    await app.signIn();
    await expect(page.locator('#ban-banner')).toHaveText(
      'You are temporarily banned from posting. Time remaining: 1m 30s',
    );
    await expect(page.locator('#text')).toBeDisabled();
  });
});

test.describe('warning banner', () => {
  test('warns a user near the ban threshold', async ({ page, app }) => {
    await app.open();
    await app.signIn({ strikes: 2, warning: true, warningThreshold: 2, banThreshold: 3 });
    const warn = page.locator('#warn-banner');
    await expect(warn).toBeVisible();
    await expect(warn).toHaveText('You have 2 flagged messages. At 3 your account is temporarily banned.');
    await expect(warn).toHaveAttribute('role', 'status');
    await expect(page.locator('#ban-banner')).toBeHidden();
    await expect(page.locator('#text')).toBeEnabled();
  });

  test('is shorter for admins and absent without a warning', async ({ page, app, api }) => {
    await app.open();
    await app.signIn({ strikes: 2, warning: true, isAdmin: true });
    await expect(page.locator('#warn-banner')).toHaveText('You have 2 flagged messages.');
    await page.locator('#signout').click();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#warn-banner')).toBeHidden();
    await app.signIn({ strikes: 0, warning: false });
    await expect(page.locator('#warn-banner')).toBeHidden();
    expect(api.calls('GET /api/me').length).toBeGreaterThanOrEqual(2);
  });
});
