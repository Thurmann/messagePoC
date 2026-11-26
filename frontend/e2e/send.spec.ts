import { expect, test } from './support/fixtures';
import type { MockResponse } from './support/mockApi';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POST = 'POST /api/messages';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function posted(id: string, text: string) {
  return { type: 'message', messageId: id, occurredAt: '2030-06-01T12:00:01Z', handle: 'alice', text };
}

test.describe('sending messages', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
    await app.signIn();
  });

  test('a message is pending until the stream confirms it', async ({ page, app, api, streams }) => {
    await app.send('hello world');

    const line = page.locator('#lines .line', { hasText: 'hello world' });
    await expect(line).toHaveCount(1);
    await expect(line).toHaveClass(/\bpending\b/);
    await expect(line.locator('.h')).toHaveText('alice');
    await expect(line.locator('.x')).toHaveText('hello world');
    await expect(line.locator('.status')).toHaveText('checking…');
    await expect(page.locator('#text')).toHaveValue('');
    await expect(page.locator('#send-error')).toBeHidden();

    await expect.poll(() => api.calls(POST).length).toBe(1);
    const req = api.calls(POST)[0]!;
    expect(req.body.text).toBe('hello world');
    expect(req.body.messageId).toMatch(UUID);
    expect(req.headers['authorization']).toBe(`Bearer ${app.token}`);
    expect(req.headers['content-type']).toContain('application/json');
    await expect(line.locator('.status')).toHaveText('checking…'); // 202 only means "accepted"
    await expect(line).not.toHaveClass(/\bunconfirmed\b/);

    await streams.push('chat', 'message', posted(req.body.messageId, 'hello world'));
    await expect(line).not.toHaveClass(/\b(pending|unconfirmed|failed)\b/);
    await expect(line.locator('.status')).toHaveCount(0);
    await expect(line.locator('.t')).toHaveCount(1); // keeps its local time
    // a repeated delivery (reconnect, history) does not add a second line
    await streams.push('chat', 'message', posted(req.body.messageId, 'hello world'));
    await expect(page.locator('#lines .line')).toHaveCount(4);
    await expect(page.locator('#send-error')).toBeHidden();
  });

  test('a stream result that beats the POST response still resolves the line', async ({ page, app, api, streams }) => {
    const gate = deferred<MockResponse>();
    api.on(POST, () => gate.promise);
    await app.send('race');
    const line = page.locator('#lines .line', { hasText: 'race' });
    await expect.poll(() => api.calls(POST).length).toBe(1);

    await streams.push('chat', 'message', posted(api.calls(POST)[0]!.body.messageId, 'race'));
    await expect(line).not.toHaveClass(/\bpending\b/);
    await expect(line.locator('.status')).toHaveCount(0);

    gate.resolve({ status: 202, json: { status: 'PENDING' } });
    await expect(page.locator('#lines .line', { hasText: 'race' })).toHaveCount(1);
    await expect(line.locator('.status')).toHaveCount(0);
    await expect(line).not.toHaveClass(/\bpending\b/);
  });

  test('the text is trimmed, an empty text is ignored and Enter sends', async ({ page, api }) => {
    await page.locator('#text').fill('   ');
    await page.locator('#send').click();
    await expect(page.locator('#text')).toHaveValue('   ');
    expect(api.calls(POST)).toHaveLength(0);

    await page.locator('#text').fill('  padded  ');
    await page.locator('#text').press('Enter');
    await expect.poll(() => api.calls(POST).length).toBe(1);
    expect(api.calls(POST)[0]!.body.text).toBe('padded');
    await expect(page.locator('#lines .line', { hasText: 'padded' }).locator('.x')).toHaveText('padded');
  });

  test('a definite failure removes the line, restores the text and reuses the message id on retry', async ({ page, app, api }) => {
    api.sequence(POST, { status: 503, json: { error: 'UNAVAILABLE' } }, { status: 202, json: { status: 'PENDING' } });
    await app.send('try me');

    await expect(page.locator('#send-error')).toHaveText('Service temporarily unavailable. Please try again.');
    await expect(page.locator('#send-error')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#lines .line', { hasText: 'try me' })).toHaveCount(0);
    await expect(page.locator('#text')).toHaveValue('try me');
    expect(api.calls(POST)).toHaveLength(1);

    await page.locator('#send').click();
    await expect.poll(() => api.calls(POST).length).toBe(2);
    expect(api.calls(POST)[1]!.body.messageId).toBe(api.calls(POST)[0]!.body.messageId);
    await expect(page.locator('#send-error')).toBeHidden();
    await expect(page.locator('#lines .line', { hasText: 'try me' })).toHaveCount(1);

    // a different text after a failure is a different message
    api.sequence(POST, { status: 503, json: { error: 'UNAVAILABLE' } }, { status: 202, json: {} });
    await app.send('first');
    await expect(page.locator('#send-error')).toBeVisible();
    await page.locator('#text').fill('second');
    await page.locator('#send').click();
    await expect.poll(() => api.calls(POST).length).toBe(4);
    expect(api.calls(POST)[3]!.body.messageId).not.toBe(api.calls(POST)[2]!.body.messageId);
  });

  test('other client errors are reported with their status', async ({ page, app, api }) => {
    api.on(POST, () => ({ status: 400, json: { error: 'INVALID_MESSAGE' } }));
    await app.send('nope');
    await expect(page.locator('#send-error')).toHaveText('Could not send message (HTTP 400).');
    await expect(page.locator('#lines .line', { hasText: 'nope' })).toHaveCount(0);
    await expect(page.locator('#text')).toHaveValue('nope');
    await expect(page.locator('#me')).toBeVisible();
  });

  test('HANDLE_REQUIRED opens the handle dialog without an error text', async ({ page, app, api }) => {
    api.on(POST, () => ({ status: 409, json: { error: 'HANDLE_REQUIRED' } }));
    await app.send('needs-handle');
    await expect(page.locator('#handle-dialog')).toBeVisible();
    await expect(page.locator('#handle-input')).toBeFocused();
    await expect(page.locator('#send-error')).toBeHidden();
    await expect(page.locator('#lines .line', { hasText: 'needs-handle' })).toHaveCount(0);
  });

  test('an expired session signs the user out and says why', async ({ page, app, api }) => {
    api.on(POST, () => ({ status: 401, json: {} }));
    await app.send('late');
    await expect(page.locator('#send-error')).toHaveText('Your session expired. Please sign in again.');
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#me')).toBeHidden();
    await expect(page.locator('#text')).toBeDisabled();
    await expect(page.locator('#lines .line', { hasText: 'late' })).toHaveCount(0);
  });

  test('signing out stops the retries of an unconfirmed message', async ({ page, app, api }) => {
    await app.send('mine');
    const line = page.locator('#lines .line', { hasText: 'mine' });
    await expect.poll(() => api.calls(POST).length).toBe(1);
    await page.locator('#signout').click();
    await expect(page.locator('#login')).toBeVisible();
    await expect(line).toHaveClass(/\bunconfirmed\b/);
    await expect(line).not.toHaveClass(/\bpending\b/);
    await expect(line.locator('.status')).toHaveText('not confirmed – it may still appear');
    await expect(page.locator('#lines .line', { hasText: 'mine' })).toHaveCount(1); // the chat is not cleared
    expect(api.calls(POST)).toHaveLength(1);
  });
});

test.describe('retrying an unconfirmed message (timers)', () => {
  test.beforeEach(async ({ page, app }) => {
    await page.clock.install({ time: Date.parse('2030-06-01T12:00:00Z') });
    await app.open();
    await app.signIn();
    await page.clock.pauseAt(Date.parse('2030-06-01T12:00:10Z'));
  });

  test('a 503 UNCONFIRMED is retried with the same message id after Retry-After', async ({ page, app, api, streams }) => {
    api.sequence(
      POST,
      { status: 503, json: { status: 'UNCONFIRMED' }, headers: { 'Retry-After': '3' } },
      { status: 202, json: { status: 'PENDING' } },
    );
    await app.send('persist');
    const line = page.locator('#lines .line', { hasText: 'persist' });
    await expect(line).toHaveClass(/\bunconfirmed\b/);
    await expect(line).not.toHaveClass(/\bpending\b/);
    await expect(line.locator('.status')).toHaveText('not confirmed yet – retrying…');
    expect(api.calls(POST)).toHaveLength(1);

    await page.clock.runFor(2900);
    expect(api.calls(POST)).toHaveLength(1);
    await page.clock.runFor(200);
    await expect.poll(() => api.calls(POST).length).toBe(2);
    expect(api.calls(POST)[1]!.body.messageId).toBe(api.calls(POST)[0]!.body.messageId);
    await expect(line.locator('.status')).toHaveText('checking…');
    await expect(line).not.toHaveClass(/\bunconfirmed\b/);

    await streams.push('chat', 'message', posted(api.calls(POST)[0]!.body.messageId, 'persist'));
    await expect(line.locator('.status')).toHaveCount(0);
    await expect(page.locator('#lines .line', { hasText: 'persist' })).toHaveCount(1);
  });

  for (const [header, ms] of [
    ['1', 3000],
    ['99', 30000],
    [undefined, 5000],
  ] as const) {
    test(`Retry-After ${header ?? '(missing)'} waits ${ms / 1000} seconds`, async ({ page, app, api }) => {
      api.sequence(
        POST,
        { status: 503, json: { status: 'UNCONFIRMED' }, headers: header === undefined ? {} : { 'Retry-After': header } },
        { status: 202, json: {} },
      );
      await app.send('clamp');
      await expect(page.locator('#lines .line', { hasText: 'clamp' }).locator('.status')).toHaveText(
        'not confirmed yet – retrying…',
      );
      await page.clock.runFor(ms - 100);
      expect(api.calls(POST)).toHaveLength(1);
      await page.clock.runFor(200);
      await expect.poll(() => api.calls(POST).length).toBe(2);
    });
  }

  test('a network error is retried after 5 seconds', async ({ page, app, api }) => {
    api.sequence(POST, { abort: true }, { status: 202, json: {} });
    await app.send('offline');
    const line = page.locator('#lines .line', { hasText: 'offline' });
    await expect(line.locator('.status')).toHaveText('not confirmed yet – retrying…');
    await expect(line).toHaveClass(/\bunconfirmed\b/);
    await page.clock.runFor(4900);
    expect(api.calls(POST)).toHaveLength(1);
    await page.clock.runFor(200);
    await expect.poll(() => api.calls(POST).length).toBe(2);
    await expect(line.locator('.status')).toHaveText('checking…');
    expect(api.calls(POST)[1]!.body.messageId).toBe(api.calls(POST)[0]!.body.messageId);
  });

  test('any other 5xx is treated as unconfirmed too', async ({ page, app, api }) => {
    api.sequence(POST, { status: 502, json: {} }, { status: 202, json: {} });
    await app.send('gateway');
    await expect(page.locator('#lines .line', { hasText: 'gateway' }).locator('.status')).toHaveText(
      'not confirmed yet – retrying…',
    );
    await page.clock.runFor(5000);
    await expect.poll(() => api.calls(POST).length).toBe(2);
  });

  test('gives up after six attempts but keeps the line', async ({ page, app, api }) => {
    api.on(POST, () => ({ status: 503, json: { status: 'UNCONFIRMED' }, headers: { 'Retry-After': '3' } }));
    await app.send('hopeless');
    const line = page.locator('#lines .line', { hasText: 'hopeless' });
    for (let attempt = 1; attempt < 6; attempt++) {
      await expect.poll(() => api.calls(POST).length).toBe(attempt);
      await expect(line.locator('.status')).toHaveText('not confirmed yet – retrying…');
      await page.clock.runFor(3000);
    }
    await expect.poll(() => api.calls(POST).length).toBe(6);
    await expect(line.locator('.status')).toHaveText('not confirmed – it may still appear');
    await expect(line).toHaveClass(/\bunconfirmed\b/);
    await page.clock.runFor(120_000);
    expect(api.calls(POST)).toHaveLength(6);
    await expect(page.locator('#lines .line', { hasText: 'hopeless' })).toHaveCount(1);
    await expect(page.locator('#send-error')).toBeHidden();
  });
});
