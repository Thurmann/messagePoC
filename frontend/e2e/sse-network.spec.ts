import { expect, test } from './support/fixtures';

// The other specs replace fetch for the stream endpoints. This one leaves it alone and serves a real
// text/event-stream response through the network layer, so the browser's own streaming and the app's
// parser (all three line endings, comments, multi-line data, bad events) are exercised end to end.
test.use({ fakeStreams: false });

const event = (id: string, text: string) =>
  JSON.stringify({ type: 'message', messageId: id, occurredAt: '2030-01-01T10:05:00Z', handle: 'dave', text });

test('parses a real event stream and reconnects when it ends', async ({ page, app, api }) => {
  const requests: Array<{ accept: string | undefined; authorization: string | undefined }> = [];
  await page.route('**/api/chat/stream', (route) => {
    const headers = route.request().headers();
    requests.push({ accept: headers['accept'], authorization: headers['authorization'] });
    const lf = `event: message\ndata: ${event('n1', 'with LF')}\n\n`;
    const crlf = `event: message\r\ndata: ${event('n2', 'with CRLF')}\r\n\r\n`;
    const cr = `event: message\rdata: ${event('n3', 'with CR')}\r\r`;
    const multiline = `event: message\ndata: {"type":"message","messageId":"n4",\ndata: "occurredAt":"2030-01-01T10:05:00Z","handle":"dave","text":"multi line data"}\n\n`;
    const unnamed = `data: ${event('n5', 'default event name')}\n\n`;
    const garbage = ': connected\n\nevent: message\ndata: {not json\n\nevent: unknown\ndata: {}\n\n: ping\n\n';
    const kafka = 'event: kafka\ndata: {"status":"DOWN"}\n\n';
    return route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: [garbage, lf, crlf, cr, multiline, unnamed, kafka].join(''),
    });
  });

  await app.open();
  // history and stream race, so compare the set of lines rather than their order
  const texts = page.locator('#lines .line .x');
  await expect
    .poll(async () => (await texts.allTextContents()).sort())
    .toEqual(
      ['Hello from alice', 'Hi alice', 'with LF', 'with CRLF', 'with CR', 'multi line data', 'default event name'].sort(),
    );
  await expect(page.locator('#lines .line', { hasText: 'with LF' }).locator('.h')).toHaveText('dave');
  expect(requests[0]).toEqual({ accept: 'text/event-stream', authorization: undefined });

  // The response ends after the last event, which is a dropped connection: the app reconnects
  // (after about a second) and the replayed events are not shown twice.
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#lines .line')).toHaveCount(8); // 3 history lines (one is the system line for the removed message) + 5 events
  expect(api.calls('GET /api/chat/history').length).toBeGreaterThanOrEqual(2);
});
