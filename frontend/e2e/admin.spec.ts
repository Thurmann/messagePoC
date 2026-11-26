import { expect, test } from './support/fixtures';
import type { ModerationRow } from './support/mockApi';
import { fakeIdToken } from './support/token';

const NEWEST: ModerationRow = {
  occurredAt: '2030-01-01T11:00:00Z',
  messageId: 'm2',
  email: 'bob@example.com',
  handle: 'bob',
  status: 'DLT',
  score: 0.5,
  text: 'second offence',
  reason: 'toxic',
  strikesAfter: 3,
  currentStrikes: 1,
  banState: { until: '2030-01-01T11:05:00Z' },
};
const OLDEST: ModerationRow = {
  occurredAt: '2030-01-01T10:00:00Z',
  messageId: 'm1',
  email: 'carol@example.com',
  handle: 'carol',
  status: 'REJECTED',
  score: 0.912,
  text: 'first offence',
  reason: 'spam',
  strikesAfter: 1,
  currentStrikes: 1,
  banState: null,
};

const localTime = (page: import('@playwright/test').Page, iso: string) =>
  page.evaluate((v) => new Date(v).toLocaleString(), iso);

test.describe('moderation rail and log (admin)', () => {
  test('an admin sees the tabs and the rail with the moderation history, newest first', async ({ page, app, api, streams }) => {
    api.moderationLog = [NEWEST, OLDEST];
    await app.open();
    const token = await app.signIn({ isAdmin: true });

    await expect(page.locator('#tabs')).toBeVisible();
    await expect(page.locator('#rail')).toBeVisible();
    await expect(page.locator('#view-chat')).not.toHaveClass(/\bno-rail\b/);
    await expect(page.locator('#tab-chat')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#tab-log')).not.toHaveClass(/\bactive\b/);

    const cards = page.locator('#cards .card');
    await expect(cards).toHaveCount(2);
    await expect(page.locator('#rail-empty')).toBeHidden();
    await expect(cards.nth(0).locator('.top b')).toHaveText('bob');
    await expect(cards.nth(0).locator('.pill')).toHaveText('DLT');
    await expect(cards.nth(0).locator('.pill')).toHaveClass(/\bp-dlt\b/);
    await expect(cards.nth(0).locator('.q')).toHaveText('second offence');
    await expect(cards.nth(0).locator('.meta').nth(0)).toHaveText('score 0.50 · strike 3 / 3');
    await expect(cards.nth(0).locator('.meta').nth(1)).toHaveText(`banned until ${await localTime(page, '2030-01-01T11:05:00Z')}`);
    await expect(cards.nth(1).locator('.top b')).toHaveText('carol');
    await expect(cards.nth(1).locator('.pill')).toHaveText('REJECTED');
    await expect(cards.nth(1).locator('.pill')).toHaveClass(/\bp-rej\b/);
    await expect(cards.nth(1).locator('.meta')).toHaveCount(1);
    await expect(cards.nth(1).locator('.meta')).toHaveText('score 0.91 · strike 1 / 3');

    expect(api.calls('GET /api/admin/moderation-log')[0]!.query).toBe('?limit=200');
    expect(api.calls('GET /api/admin/moderation-log')[0]!.headers['authorization']).toBe(`Bearer ${token}`);
    const [adminStream] = await streams.requests('admin');
    expect(adminStream!.authorization).toBe(`Bearer ${token}`);
    expect(adminStream!.accept).toBe('text/event-stream');

    // live events go on top; the same message and status is not shown twice
    const live: ModerationRow = { ...OLDEST, messageId: 'm3', handle: null, status: 'REJECTED', text: 'x'.repeat(130), score: null, strikesAfter: null, banState: null };
    await streams.push('admin', 'moderation', live);
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).locator('.top b')).toHaveText('(unknown)');
    await expect(cards.nth(0).locator('.q')).toHaveText(`${'x'.repeat(120)}…`);
    await expect(cards.nth(0).locator('.meta')).toHaveCount(0);
    await streams.push('admin', 'moderation', live);
    await streams.push('admin', 'moderation', { ...live, status: 'DLT' }); // same message, other status: a new entry
    await expect(cards).toHaveCount(4);
    await expect(cards.nth(0).locator('.pill')).toHaveText('DLT');
    await streams.push('admin', 'resync', {});
    await expect.poll(() => api.calls('GET /api/admin/moderation-log').length).toBe(2);
    await expect(cards).toHaveCount(4);
  });

  test('a resync loads rows that were missed', async ({ page, app, api, streams }) => {
    api.moderationLog = [OLDEST];
    await app.open();
    await app.signIn({ isAdmin: true });
    await expect(page.locator('#cards .card')).toHaveCount(1);
    api.moderationLog = [NEWEST, OLDEST];
    await streams.push('admin', 'resync', {});
    await expect(page.locator('#cards .card')).toHaveCount(2);
    await expect(page.locator('#cards .card').nth(0).locator('.top b')).toHaveText('bob');
  });

  test('the rail says so when there is nothing flagged', async ({ page, app }) => {
    await app.open();
    await app.signIn({ isAdmin: true });
    await expect(page.locator('#rail')).toBeVisible();
    await expect(page.locator('#cards .card')).toHaveCount(0);
    await expect(page.locator('#rail-empty')).toBeVisible();
    await expect(page.locator('#rail-empty')).toHaveText('No flagged messages yet.');
  });

  test('the log tab shows the same rows as a table', async ({ page, app, api }) => {
    api.moderationLog = [NEWEST, OLDEST];
    await app.open();
    await app.signIn({ isAdmin: true });
    await expect(page.locator('#cards .card')).toHaveCount(2);

    await page.locator('#tab-log').click();
    await expect(page.locator('#view-log')).toBeVisible();
    await expect(page.locator('#view-chat')).toBeHidden();
    await expect(page.locator('#tab-log')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#tab-chat')).not.toHaveClass(/\bactive\b/);
    await expect(page.locator('#view-log th')).toHaveText([
      'Time', 'User', 'Handle', 'Status', 'Score', 'Text', 'Reason', 'Strikes', 'Ban',
    ]);
    const rows = page.locator('#log-body tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('td')).toHaveText([
      await localTime(page, NEWEST.occurredAt),
      'bob@example.com',
      'bob',
      'DLT',
      '0.50',
      'second offence',
      'toxic',
      '3 (now 1)',
      `banned until ${await localTime(page, '2030-01-01T11:05:00Z')}`,
    ]);
    await expect(rows.nth(0).locator('td').nth(3).locator('.pill')).toHaveClass(/\bp-dlt\b/);
    await expect(rows.nth(1).locator('td')).toHaveText([
      await localTime(page, OLDEST.occurredAt),
      'carol@example.com',
      'carol',
      'REJECTED',
      '0.91',
      'first offence',
      'spam',
      '1 (now 1)',
      '',
    ]);

    await page.locator('#tab-chat').click();
    await expect(page.locator('#view-chat')).toBeVisible();
    await expect(page.locator('#view-log')).toBeHidden();
    await expect(page.locator('#tab-chat')).toHaveClass(/\bactive\b/);

    // signing out leaves the log tab
    await page.locator('#tab-log').click();
    await page.locator('#signout').click();
    await expect(page.locator('#view-chat')).toBeVisible();
    await expect(page.locator('#view-log')).toBeHidden();
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#rail')).toBeHidden();
  });

  test('a regular user gets no admin UI and no admin stream', async ({ page, app, api, streams }) => {
    await app.open();
    await app.signIn();
    await streams.waitOpen('chat');
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#rail')).toBeHidden();
    await expect(page.locator('#view-chat')).toHaveClass(/\bno-rail\b/);
    expect(await streams.requests('admin')).toHaveLength(0);
    expect(api.calls('GET /api/admin/moderation-log')).toHaveLength(0);
  });

  test('an unauthorized moderation log signs the user out', async ({ page, app, api }) => {
    api.on('GET /api/admin/moderation-log', () => ({ status: 401, json: {} }));
    await app.open();
    await app.deliverCredential({ isAdmin: true });
    await expect.poll(() => api.calls('GET /api/admin/moderation-log').length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#me')).toBeHidden();
    await expect(page.locator('#rail')).toBeHidden();
  });

  test('a 403 on the admin stream removes the admin UI for good', async ({ page, app, streams }) => {
    await streams.setMode('admin', 403);
    await page.clock.install({ time: Date.parse('2030-06-01T12:00:00Z') });
    await app.open();
    await app.signIn({ isAdmin: true });
    await expect.poll(async () => (await streams.requests('admin')).length).toBe(1);
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#rail')).toBeHidden();
    await expect(page.locator('#me')).toBeVisible(); // still signed in
    await expect(page.locator('#text')).toBeEnabled();
    await page.clock.runFor(120_000); // far beyond any reconnect delay
    expect(await streams.requests('admin')).toHaveLength(1);
  });

  test('a 401 on the admin stream renews the token once, then signs out', async ({ page, app, streams }) => {
    await streams.setMode('admin', 401);
    await app.open();
    const renewed = fakeIdToken({ nonce: 'renewed' });
    await app.google.setPrompt('credential', renewed);
    await app.deliverCredential({ isAdmin: true });
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#me')).toBeHidden();
    const requests = await streams.requests('admin');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.authorization).toBe(`Bearer ${app.token}`);
    expect(requests[1]!.authorization).toBe(`Bearer ${renewed}`);
    expect((await app.google.state()).prompts).toBe(1);
  });

  test('a 401 on the admin stream signs out straight away when no renewal is possible', async ({ page, app, streams }) => {
    await streams.setMode('admin', 401);
    await app.open();
    await app.deliverCredential({ isAdmin: true }); // the fake prompt reports "not displayed"
    await expect.poll(async () => (await streams.requests('admin')).length).toBe(1);
    await expect(page.locator('#login')).toBeVisible();
    expect(await streams.requests('admin')).toHaveLength(1);
  });
});

test.describe('banning users from the online list (admin)', () => {
  const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

  test.beforeEach(async ({ app, api }) => {
    api.users = [
      { handle: 'alice' },
      { handle: 'bob' },
      { handle: 'root', isAdmin: true },
      { handle: 'carol', bannedUntil: FUTURE() },
    ];
    await app.open();
    await app.signIn({ isAdmin: true });
  });

  test('only other, non-admin, unbanned users get a Ban button', async ({ page }) => {
    await expect(page.locator('#users-count')).toHaveText('4');
    await expect(page.locator('#users-list li')).toHaveCount(4);
    await expect(page.locator('#users-list button')).toHaveCount(1);
    const ban = page.getByRole('button', { name: 'Ban bob' });
    await expect(ban).toBeVisible();
    await expect(ban).toHaveText('Ban');
    await expect(ban).toHaveClass(/\bdanger\b/);
    await expect(page.locator('#users-list li', { hasText: 'carol' }).locator('.banned')).toHaveText(/^banned · (\d+h )?\d+m \d+s$/);
    await expect(page.locator('#users-list li', { hasText: 'root' }).locator('.tag')).toHaveText('admin');
  });

  test('confirming bans the user and refreshes the list', async ({ page, api }) => {
    const prompts: string[] = [];
    page.on('dialog', (d) => {
      prompts.push(d.message());
      void d.accept();
    });
    api.on('POST /api/admin/users/ban', () => {
      api.users = api.users.map((u) => (u.handle === 'bob' ? { ...u, bannedUntil: FUTURE() } : u));
      return { status: 200, json: {} };
    });
    const polls = api.calls('GET /api/users/online').length;
    await page.getByRole('button', { name: 'Ban bob' }).click();

    await expect(page.locator('#users-list li', { hasText: 'bob' }).locator('.banned')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ban bob' })).toHaveCount(0);
    expect(prompts).toEqual(['Ban @bob? The ban length follows the ladder (1 min, 5 min, 30 min, …).']);
    expect(api.calls('POST /api/admin/users/ban')[0]!.body).toEqual({ handle: 'bob' });
    expect(api.calls('GET /api/users/online').length).toBeGreaterThan(polls);
    await expect(page.locator('#users-error')).toBeHidden();
  });

  test('declining the confirmation sends nothing', async ({ page, api }) => {
    page.on('dialog', (d) => void d.dismiss());
    await page.getByRole('button', { name: 'Ban bob' }).click();
    await expect(page.getByRole('button', { name: 'Ban bob' })).toBeEnabled();
    expect(api.calls('POST /api/admin/users/ban')).toHaveLength(0);
  });

  const failures: Array<[string, number, unknown, string]> = [
    ['not allowed', 403, {}, 'You are not allowed to ban users.'],
    ['gone', 404, { error: 'UNKNOWN_HANDLE' }, '@bob no longer exists.'],
    ['an admin', 409, { error: 'CANNOT_BAN_ADMIN' }, 'Admins cannot be banned.'],
    ['already banned', 409, { error: 'ALREADY_BANNED' }, '@bob is already banned.'],
    ['other 409', 409, {}, 'Could not ban @bob (HTTP 409).'],
    ['server error', 500, {}, 'Could not ban @bob (HTTP 500).'],
  ];
  for (const [name, status, body, message] of failures) {
    test(`reports "${message}" (${name})`, async ({ page, api }) => {
      page.on('dialog', (d) => void d.accept());
      api.on('POST /api/admin/users/ban', () => ({ status, json: body }));
      await page.getByRole('button', { name: 'Ban bob' }).click();
      await expect(page.locator('#users-error')).toHaveText(message);
      await expect(page.locator('#users-error')).toHaveAttribute('role', 'alert');
      await expect(page.getByRole('button', { name: 'Ban bob' })).toBeEnabled();
    });
  }

  test('reports a network error', async ({ page, api }) => {
    page.on('dialog', (d) => void d.accept());
    api.on('POST /api/admin/users/ban', () => ({ abort: true }));
    await page.getByRole('button', { name: 'Ban bob' }).click();
    await expect(page.locator('#users-error')).toHaveText('Network error. Try again.');
  });

  test('an error is cleared when the next ban starts', async ({ page, api }) => {
    page.on('dialog', (d) => void d.accept());
    api.sequence('POST /api/admin/users/ban', { status: 500, json: {} }, { status: 200, json: {} });
    await page.getByRole('button', { name: 'Ban bob' }).click();
    await expect(page.locator('#users-error')).toBeVisible();
    await page.getByRole('button', { name: 'Ban bob' }).click();
    await expect.poll(() => api.calls('POST /api/admin/users/ban').length).toBe(2);
    await expect(page.locator('#users-error')).toBeHidden();
  });

  test('a 403 also reloads the profile', async ({ page, api }) => {
    page.on('dialog', (d) => void d.accept());
    api.on('POST /api/admin/users/ban', () => ({ status: 403, json: {} }));
    const loads = api.calls('GET /api/me').length;
    await page.getByRole('button', { name: 'Ban bob' }).click();
    await expect.poll(() => api.calls('GET /api/me').length).toBeGreaterThan(loads);
  });
});

test.describe('audit logs (admin)', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
    await app.signIn({ isAdmin: true });
  });

  test('lists up to 30 entries', async ({ page, api }) => {
    api.auditLogs = Array.from({ length: 35 }, (_, i) => ({
      timestamp: '2030-01-01T10:00:00Z',
      message: `message ${i}`,
      result: 'ALLOWED',
      text: i === 0 ? 'hello audit' : i === 1 ? undefined : i === 2 ? 'y'.repeat(100) : `text ${i}`,
    }));
    await expect(page.locator('#audit')).toBeEmpty();
    await page.locator('#audit-btn').click();
    const items = page.locator('#audit li');
    await expect(items).toHaveCount(30);
    const when = await localTime(page, '2030-01-01T10:00:00Z');
    await expect(items.nth(0)).toHaveText(`${when} · ALLOWED · hello audit`);
    await expect(items.nth(1)).toHaveText(`${when} · ALLOWED · message 1`);
    await expect(items.nth(2)).toHaveText(`${when} · ALLOWED · ${'y'.repeat(80)}…`);
    expect(api.calls('GET /api/audit-logs')).toHaveLength(1);
    // loading again replaces the list
    await page.locator('#audit-btn').click();
    await expect.poll(() => api.calls('GET /api/audit-logs').length).toBe(2);
    await expect(items).toHaveCount(30);
  });

  test('says so when there are no entries', async ({ page }) => {
    await page.locator('#audit-btn').click();
    await expect(page.locator('#audit li')).toHaveText(['No audit entries.']);
  });

  test('says so when loading fails, and a 401 does not sign out', async ({ page, api }) => {
    api.on('GET /api/audit-logs', () => ({ status: 500, json: {} }));
    await page.locator('#audit-btn').click();
    await expect(page.locator('#audit li')).toHaveText(['Could not load audit logs.']);
    api.on('GET /api/audit-logs', () => ({ status: 401, json: {} }));
    await page.locator('#audit-btn').click();
    await expect(page.locator('#audit li')).toHaveText(['Could not load audit logs.']);
    await expect(page.locator('#me')).toBeVisible();
    await expect(page.locator('#login')).toBeHidden();
  });
});
