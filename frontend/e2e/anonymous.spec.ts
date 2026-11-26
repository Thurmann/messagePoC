import { expect, test } from './support/fixtures';

test.describe('anonymous visitor', () => {
  test('sees the chat history, a live connection and a login button', async ({ page, app, api }) => {
    await app.open();

    // history, oldest first; one line per message, a system line for the removed one
    const lines = page.locator('#lines .line');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(0).locator('.h')).toHaveText('alice');
    await expect(lines.nth(0).locator('.x')).toHaveText('Hello from alice');
    await expect(lines.nth(0).locator('.t')).toHaveCount(1);
    await expect(lines.nth(1).locator('.h')).toHaveText('bob');
    await expect(lines.nth(1).locator('.x')).toHaveText('Hi alice');
    await expect(lines.nth(2)).toHaveClass(/\bsys\b/);
    await expect(lines.nth(2)).toHaveText('A message from carol was removed by moderation.');
    await expect(page.locator('#lines')).toHaveAttribute('role', 'log');

    const conn = page.locator('#conn');
    await expect(conn).toHaveText('live');
    await expect(conn).toHaveClass(/\bon\b/);
    await expect(conn).not.toHaveClass(/\bwarn\b/);
    await expect(conn).toHaveAttribute('title', 'Connected to the live chat stream.');

    await expect(page.locator('#version')).toBeVisible();
    await expect(page.locator('#version')).toHaveText('v1.2.3');
    await expect(page.locator('#version')).toHaveAttribute('title', 'Running version 1.2.3');

    // signed out: login button shown, everything that needs a session hidden
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.getByTestId('fake-gsi')).toBeVisible();
    await expect(page.locator('#setup')).toBeHidden();
    await expect(page.locator('#me')).toBeHidden();
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#users')).toBeHidden();
    await expect(page.locator('#rail')).toBeHidden();
    await expect(page.locator('#warn-banner')).toBeHidden();
    await expect(page.locator('#ban-banner')).toBeHidden();
    await expect(page.locator('#send-error')).toBeHidden();
    await expect(page.locator('#handle-dialog')).toBeHidden();
    await expect(page.locator('#view-chat')).toHaveClass(/\bno-users\b/);
    await expect(page.locator('#view-chat')).toHaveClass(/\bno-rail\b/);

    const composer = page.locator('#text');
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute('placeholder', 'Sign in to chat');
    await expect(page.locator('#send')).toBeDisabled();

    // what the page asked the backend for
    expect(api.calls('GET /api/config')).toHaveLength(1);
    expect(api.calls('GET /api/chat/history')[0]!.query).toBe('?limit=100');
    expect(api.calls('GET /api/chat/kafka-status').length).toBeGreaterThanOrEqual(1);
    expect(api.calls('GET /api/me')).toHaveLength(0);
    // Google sign-in was set up with the configured client id
    const gsi = await app.google.state();
    expect(gsi.initCalls).toEqual([{ client_id: 'test-client', auto_select: true }]);
    expect(gsi.renderCalls).toBe(1);
  });

  test('shows "offline" until the first stream result', async ({ page, app, streams }) => {
    await streams.setMode('chat', 'hang');
    await app.open();
    await expect(page.locator('#conn')).toHaveText('offline');
    await expect(page.locator('#conn')).not.toHaveClass(/\b(on|warn)\b/);
  });

  test('without a Google client id explains how to enable sign-in', async ({ page, app, api }) => {
    api.config = { googleClientId: '', messageApiBaseUrl: '', version: '1.2.3' };
    await page.goto('/');
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#setup')).toHaveText('Set GOOGLE_CLIENT_ID to enable sign-in');
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#lines .line')).toHaveCount(3);
    expect((await app.google.state()).initCalls).toEqual([]);
  });

  test('keeps working when /api/config fails: no version, no sign-in', async ({ page, api }) => {
    api.config = null;
    await page.goto('/');
    await expect(page.locator('#setup')).toHaveText('Set GOOGLE_CLIENT_ID to enable sign-in');
    await expect(page.locator('#version')).toBeHidden();
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#lines .line')).toHaveCount(3);
    await expect(page.locator('#conn')).toHaveText('live');
  });

  test('tells the visitor when the Google script cannot be loaded', async ({ page, google }) => {
    google.blocked = true;
    await page.goto('/');
    await expect(page.locator('#setup')).toBeVisible();
    await expect(page.locator('#setup')).toHaveText('Could not load Google sign-in.');
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#lines .line')).toHaveCount(3);
  });
});
