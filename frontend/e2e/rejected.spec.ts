import { expect, test } from './support/fixtures';

const POST = 'POST /api/messages';

test.describe('moderation rejects a message', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
    await app.signIn();
  });

  test('the own pending line turns into a failed one and the profile is reloaded', async ({ page, app, api, streams }) => {
    await app.send('something rude');
    const line = page.locator('#lines .line', { hasText: 'something rude' });
    await expect.poll(() => api.calls(POST).length).toBe(1);
    const messageId = api.calls(POST)[0]!.body.messageId;
    const profileLoads = api.calls('GET /api/me').length;
    api.me = { ...api.me, strikes: 1 };

    await streams.push('chat', 'removed', {
      type: 'removed',
      messageId,
      occurredAt: '2030-06-01T12:00:02Z',
      handle: 'alice',
    });

    await expect(line).toHaveClass(/\bfailed\b/);
    await expect(line).not.toHaveClass(/\b(pending|unconfirmed)\b/);
    await expect(line.locator('.status')).toHaveText('not posted · flagged by moderation');
    await expect(line.locator('.x')).toHaveText('something rude');
    await expect.poll(() => api.calls('GET /api/me').length).toBeGreaterThan(profileLoads);
    // still a normal chat: no retry, no error text, one line only
    await expect(page.locator('#send-error')).toBeHidden();
    await expect(page.locator('#lines .line', { hasText: 'something rude' })).toHaveCount(1);
    expect(api.calls(POST)).toHaveLength(1);
  });

  test('a removal that arrives while the POST is still unanswered also fails the line', async ({ page, app, api, streams }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.on(POST, async () => {
      await gate;
      return { status: 202, json: { status: 'PENDING' } };
    });
    await app.send('too late');
    const line = page.locator('#lines .line', { hasText: 'too late' });
    await expect.poll(() => api.calls(POST).length).toBe(1);
    await streams.push('chat', 'removed', {
      type: 'removed',
      messageId: api.calls(POST)[0]!.body.messageId,
      occurredAt: '2030-06-01T12:00:02Z',
      handle: 'alice',
    });
    await expect(line).toHaveClass(/\bfailed\b/);
    release();
    await expect(line).toHaveClass(/\bfailed\b/);
    await expect(line.locator('.status')).toHaveText('not posted · flagged by moderation');
  });

  test('someone else\'s removed message is a system line, shown once', async ({ page, streams }) => {
    const removed = { type: 'removed', messageId: 'x1', occurredAt: '2030-06-01T12:00:02Z', handle: 'mallory' };
    await streams.push('chat', 'removed', removed);
    const line = page.locator('#lines .line.sys', { hasText: 'mallory' });
    await expect(line).toHaveText('A message from mallory was removed by moderation.');
    await streams.push('chat', 'removed', removed);
    await streams.push('chat', 'message', { type: 'message', messageId: 'x2', occurredAt: '2030-06-01T12:00:03Z', handle: 'bob', text: 'marker' });
    await expect(page.locator('#lines .line', { hasText: 'marker' })).toHaveCount(1);
    await expect(line).toHaveCount(1);
  });

  test('events without a message id are ignored', async ({ page, streams }) => {
    await streams.push('chat', 'message', { type: 'message', handle: 'bob', text: 'ghost' });
    await streams.push('chat', 'message', { type: 'message', messageId: 'x3', occurredAt: '2030-06-01T12:00:03Z', handle: 'bob', text: 'marker' });
    await expect(page.locator('#lines .line', { hasText: 'marker' })).toHaveCount(1);
    await expect(page.locator('#lines .line', { hasText: 'ghost' })).toHaveCount(0);
  });
});
