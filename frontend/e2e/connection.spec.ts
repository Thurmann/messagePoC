import { expect, test } from './support/fixtures';
import type { PublicEvent } from './support/mockApi';

const message = (id: string, text: string, handle = 'bob'): PublicEvent => ({
  type: 'message',
  messageId: id,
  occurredAt: '2030-01-01T10:01:00Z',
  handle,
  text,
});

const WARN_TEXT = 'live · Kafka unavailable, messages delayed';
const WARN_TITLE =
  'Live updates work, but the message broker is unavailable. Messages you send are retried until confirmed.';

test.describe('chat stream connection', () => {
  test('the public stream is requested without credentials', async ({ app, streams }) => {
    await app.open();
    await streams.waitOpen('chat');
    const [request] = await streams.requests('chat');
    expect(request!.accept).toBe('text/event-stream');
    expect(request!.authorization).toBeNull();
  });

  test('a dropped stream shows "reconnecting…" and recovers without duplicating lines', async ({ page, app, api, streams }) => {
    await app.open();
    const conn = page.locator('#conn');
    await expect(conn).toHaveText('live');
    await streams.push('chat', 'message', message('live1', 'before the drop'));
    await expect(page.locator('#lines .line')).toHaveCount(4);
    expect(api.calls('GET /api/chat/history')).toHaveLength(1);

    // while the stream is down the server gets a new message; the history fetch after reconnecting picks it up
    api.history = [...api.history, message('live1', 'before the drop'), message('missed', 'sent while offline')];
    await streams.setMode('chat', 'error');
    await streams.drop('chat');
    await expect(conn).toHaveText('reconnecting…');
    await expect(conn).toHaveAttribute('title', 'Connection to the chat stream lost; reconnecting.');
    await expect(conn).not.toHaveClass(/\b(on|warn)\b/);

    await streams.setMode('chat', 'ok');
    await expect(conn).toHaveText('live', { timeout: 15_000 }); // backoff: 1 s, then 2 s
    await expect(conn).toHaveClass(/\bon\b/);
    await expect(page.locator('#lines .line', { hasText: 'sent while offline' })).toHaveCount(1);
    await expect(page.locator('#lines .line', { hasText: 'before the drop' })).toHaveCount(1);
    await expect(page.locator('#lines .line')).toHaveCount(5);
    expect(api.calls('GET /api/chat/history').length).toBeGreaterThanOrEqual(2);

    // the new connection delivers events again
    await streams.push('chat', 'message', message('live2', 'after the drop'));
    await expect(page.locator('#lines .line', { hasText: 'after the drop' })).toHaveCount(1);
  });

  test('a failing stream request is retried with growing delays', async ({ page, app, streams }) => {
    await page.clock.install({ time: Date.parse('2030-06-01T12:00:00Z') });
    await streams.setMode('chat', 500);
    await app.open();
    await expect(page.locator('#conn')).toHaveText('reconnecting…');
    const count = async () => (await streams.requests('chat')).length;
    // delays 1 s, 2 s, 4 s: each check keeps a generous margin because the clock keeps running while requests settle
    await expect.poll(count).toBe(1);
    await page.clock.runFor(400);
    expect(await count()).toBe(1);
    await page.clock.runFor(800);
    await expect.poll(count).toBe(2);
    await page.clock.runFor(1000);
    expect(await count()).toBe(2);
    await page.clock.runFor(1500);
    await expect.poll(count).toBe(3);
    await page.clock.runFor(2000);
    expect(await count()).toBe(3);
    await page.clock.runFor(2500);
    await expect.poll(count).toBe(4);

    await streams.setMode('chat', 'ok');
    await page.clock.runFor(9000);
    await expect(page.locator('#conn')).toHaveText('live');
  });

  test('a resync event reloads the history', async ({ page, app, api, streams }) => {
    await app.open();
    await expect(page.locator('#lines .line')).toHaveCount(3);
    const loads = api.calls('GET /api/chat/history').length;
    api.history = [...api.history, message('late', 'arrived late')];
    await streams.push('chat', 'resync', {});
    await expect(page.locator('#lines .line', { hasText: 'arrived late' })).toHaveCount(1);
    await expect(page.locator('#lines .line')).toHaveCount(4);
    expect(api.calls('GET /api/chat/history').length).toBe(loads + 1);
  });
});

test.describe('Kafka status', () => {
  test('is shown when the broker is down and clears when it is back', async ({ page, app, streams }) => {
    await app.open();
    await app.signIn();
    const conn = page.locator('#conn');
    const text = page.locator('#text');
    await expect(conn).toHaveText('live');
    await expect(text).toHaveAttribute('placeholder', 'Write a message');

    await streams.push('chat', 'kafka', { status: 'DOWN', since: '2030-01-01T10:00:00Z', checkedAt: '2030-01-01T10:00:00Z' });
    await expect(conn).toHaveText(WARN_TEXT);
    await expect(conn).toHaveClass(/\bwarn\b/);
    await expect(conn).not.toHaveClass(/\bon\b/);
    await expect(conn).toHaveAttribute('title', WARN_TITLE);
    await expect(text).toHaveAttribute('placeholder', 'Write a message (Kafka unavailable, messages may be delayed)');
    await expect(text).toBeEnabled(); // sending still works, it is just delayed

    await streams.push('chat', 'kafka', { status: 'UP', since: '2030-01-01T10:05:00Z', checkedAt: '2030-01-01T10:05:00Z' });
    await expect(conn).toHaveText('live');
    await expect(conn).toHaveClass(/\bon\b/);
    await expect(conn).not.toHaveClass(/\bwarn\b/);
    await expect(conn).toHaveAttribute('title', 'Connected to the live chat stream.');
    await expect(text).toHaveAttribute('placeholder', 'Write a message');
  });

  test('is read on load', async ({ page, app, api }) => {
    api.kafka = 'DOWN';
    await app.open();
    await expect(page.locator('#conn')).toHaveText(WARN_TEXT);
    await expect(page.locator('#conn')).toHaveClass(/\bwarn\b/);
    expect(api.calls('GET /api/chat/kafka-status').length).toBeGreaterThanOrEqual(1);
  });

  test('an unknown status counts as healthy', async ({ page, app, streams }) => {
    await app.open();
    await streams.push('chat', 'kafka', { status: 'DOWN' });
    await expect(page.locator('#conn')).toHaveText(WARN_TEXT);
    await streams.push('chat', 'kafka', { status: 'SOMETHING_ELSE' });
    await expect(page.locator('#conn')).toHaveText('live');
    await expect(page.locator('#conn')).toHaveClass(/\bon\b/);
  });
});
