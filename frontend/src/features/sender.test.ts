import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reply } from '../test/fakes';
import { createHarness, emit, meResponse, type Harness } from '../test/harness';
import { NOT_CONFIRMED } from './sender';

const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-03-01T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

async function signedIn(me = meResponse()): Promise<void> {
  h = createHarness();
  await h.bootSignedIn(me);
}
async function send(text: string): Promise<void> {
  h.app.actions.setDraft(text);
  h.app.actions.submit();
  await h.flush();
}
const posts = () => h.deps.fakeFetch.requestsTo('POST', '/api/messages');
const lines = () => h.state().lines;
const line = (key = ID1) => lines().find((l) => l.key === key);
const route = (...replies: (() => Response)[]) => {
  let i = 0;
  h.deps.fakeFetch.on('POST', '/api/messages', () => (replies[Math.min(i++, replies.length - 1)] as () => Response)());
};
const unconfirmed503 = (retryAfter?: string) => () =>
  reply(503, { status: 'UNCONFIRMED' }, retryAfter ? { 'Retry-After': retryAfter } : {});

describe('submit (P2)', () => {
  beforeEach(() => signedIn());

  it('trims, clears the draft and the send error, and appends a pending line before the POST resolves', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/messages', () => new Promise<Response>((r) => (release = r)));
    h.app.store.set((s) => ({ ...s, sendError: 'old error' }));
    h.app.actions.setDraft('  hello  ');
    h.app.actions.submit();
    expect(h.state().draft).toBe('');
    expect(h.state().sendError).toBe('');
    expect(line()).toMatchObject({
      kind: 'user',
      handle: 'alice',
      text: 'hello',
      time: '2025-03-01T12:00:00.000Z',
      pending: true,
      unconfirmed: false,
      failed: false,
      status: 'checking…',
    });
    release(reply(202, { status: 'PENDING' }));
    await h.flush();
  });

  it('POSTs {text, messageId} as JSON with the bearer token', async () => {
    await send('hello');
    expect(posts()).toHaveLength(1);
    const req = posts()[0]!;
    expect(JSON.parse(req.body ?? '')).toEqual({ text: 'hello', messageId: ID1 });
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.headers.Authorization).toMatch(/^Bearer /);
  });

  it('ignores empty and whitespace-only text', async () => {
    await send('   ');
    expect(lines()).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it('ignores a submit while the composer is disabled (banned)', async () => {
    h.app.store.set((s) => ({ ...s, ban: { until: Date.now() + 60_000, label: '1m 0s' } }));
    await send('hello');
    expect(posts()).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });
});

describe('POST outcomes (P3-P6)', () => {
  beforeEach(() => signedIn());

  it('P5 202: keeps the line pending with status "checking…" and drops the unconfirmed flag', async () => {
    await send('hello');
    expect(line()).toMatchObject({ pending: true, unconfirmed: false, status: 'checking…' });
  });

  it('P5 quirk: after an unconfirmed retry, a 202 shows "checking…" without re-adding the pending class', async () => {
    route(unconfirmed503('3'), () => reply(202, { status: 'PENDING' }));
    await send('hello');
    expect(line()).toMatchObject({ pending: false, unconfirmed: true, status: 'not confirmed yet – retrying…' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(line()).toMatchObject({ pending: false, unconfirmed: false, status: 'checking…' });
  });

  it('P4 network error: unconfirmed, retried after 5s with the same messageId', async () => {
    let first = true;
    h.deps.fakeFetch.on('POST', '/api/messages', () => {
      if (first) {
        first = false;
        throw new Error('offline');
      }
      return reply(202, { status: 'PENDING' });
    });
    await send('hello');
    expect(line()).toMatchObject({ unconfirmed: true, pending: false, status: 'not confirmed yet – retrying…' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts()).toHaveLength(2);
    expect(posts().map((p) => JSON.parse(p.body ?? '').messageId)).toEqual([ID1, ID1]);
  });

  it.each([
    ['3', 3000],
    ['1', 3000],
    ['10', 10000],
    ['99', 30000],
    [undefined, 5000],
  ])('P6 503 UNCONFIRMED with Retry-After %s retries after %i ms', async (retryAfter, ms) => {
    route(unconfirmed503(retryAfter), () => reply(202, {}));
    await send('hello');
    expect(line()).toMatchObject({ unconfirmed: true, status: 'not confirmed yet – retrying…' });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(posts()).toHaveLength(2);
  });

  it('P6 other 5xx is treated as unconfirmed and retried', async () => {
    route(() => reply(500, { error: 'BOOM' }), () => reply(202, {}));
    await send('hello');
    expect(line()).toMatchObject({ unconfirmed: true, status: 'not confirmed yet – retrying…' });
    expect(h.state().sendError).toBe('');
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts()).toHaveLength(2);
  });

  it('P6 a 5xx without a JSON body is also unconfirmed', async () => {
    route(() => new Response('oops', { status: 502 }), () => reply(202, {}));
    await send('hello');
    expect(line()).toMatchObject({ unconfirmed: true });
  });

  it('P7 gives up after 6 attempts: status "not confirmed – it may still appear", no more POSTs, still resolvable', async () => {
    route(unconfirmed503('3'));
    await send('hello');
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(3000);
    expect(posts()).toHaveLength(6);
    expect(line()).toMatchObject({ unconfirmed: true, pending: false, status: NOT_CONFIRMED });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts()).toHaveLength(6);
    // a late result still resolves the line
    await emit(h.publicStreams[0], 'message', { messageId: ID1, handle: 'alice', text: 'hello', occurredAt: '2025-03-01T12:05:00Z' });
    expect(line()).toMatchObject({ unconfirmed: false, pending: false, status: null });
  });

  it('P7 shows the retrying text for attempts 1 to 5', async () => {
    route(unconfirmed503('3'));
    await send('hello');
    for (let i = 1; i < 5; i++) {
      expect(line()?.status).toBe('not confirmed yet – retrying…');
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(posts()).toHaveLength(5);
    expect(line()?.status).toBe('not confirmed yet – retrying…');
  });
});

describe('stream result racing the POST (P2, F2)', () => {
  beforeEach(() => signedIn());

  it('a stream message arriving before the POST response resolves the line; the late response changes nothing', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/messages', () => new Promise<Response>((r) => (release = r)));
    await send('hello');
    expect(line()?.pending).toBe(true);
    await emit(h.publicStreams[0], 'message', { messageId: ID1, handle: 'alice', text: 'hello', occurredAt: '2025-03-01T12:00:05Z' });
    expect(line()).toMatchObject({ pending: false, unconfirmed: false, status: null });
    release(reply(202, {}));
    await h.flush();
    expect(line()).toMatchObject({ pending: false, unconfirmed: false, status: null });
    expect(lines()).toHaveLength(1);
  });

  it('a late 503 after the stream resolved the line does not schedule a retry or show an error', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/messages', () => new Promise<Response>((r) => (release = r)));
    await send('hello');
    await emit(h.publicStreams[0], 'message', { messageId: ID1, handle: 'alice', text: 'hello', occurredAt: '2025-03-01T12:00:05Z' });
    release(unconfirmed503('3')());
    await h.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts()).toHaveLength(1);
    expect(h.state().sendError).toBe('');
  });

  it('F2 keeps the local send time on the resolved line', async () => {
    await send('hello');
    await emit(h.publicStreams[0], 'message', { messageId: ID1, handle: 'alice', text: 'hello', occurredAt: '2030-01-01T00:00:00Z' });
    expect(line()?.time).toBe('2025-03-01T12:00:00.000Z');
  });

  it('F3 a removed event marks the line failed and refreshes the profile', async () => {
    await send('hello');
    const before = h.deps.fakeFetch.requestsTo('GET', '/api/me').length;
    await emit(h.publicStreams[0], 'removed', { messageId: ID1, handle: 'alice', occurredAt: '2025-03-01T12:00:05Z' });
    expect(line()).toMatchObject({
      pending: false,
      unconfirmed: false,
      failed: true,
      status: 'not posted · flagged by moderation',
    });
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/me').length).toBe(before + 1);
  });

  it('a removed event also stops further retries of that message', async () => {
    route(unconfirmed503('3'));
    await send('hello');
    await emit(h.publicStreams[0], 'removed', { messageId: ID1, handle: 'alice', occurredAt: '2025-03-01T12:00:05Z' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posts()).toHaveLength(1);
  });
});

describe('sign-out while sending (S7)', () => {
  beforeEach(() => signedIn());

  it('stops retries, marks the line unconfirmed and keeps the entry resolvable', async () => {
    route(unconfirmed503('3'));
    await send('hello');
    h.app.actions.signOut();
    expect(line()).toMatchObject({ pending: false, unconfirmed: true, status: NOT_CONFIRMED });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts()).toHaveLength(1);
    // the pending entry survives sign-out: a late stream result still resolves the line
    await emit(h.publicStreams[0], 'message', { messageId: ID1, handle: 'alice', text: 'hello', occurredAt: '2025-03-01T12:00:09Z' });
    expect(line()).toMatchObject({ pending: false, unconfirmed: false, status: null });
  });

  it('does not clear the chat lines and forgets the last failure', async () => {
    route(() => reply(503, { error: 'UNAVAILABLE' }));
    await send('hello');
    h.app.actions.signOut();
    expect(lines()).toHaveLength(0); // the failed line was removed by failMessage, none cleared by sign-out
    await emit(h.publicStreams[0], 'message', { messageId: 'other', handle: 'bob', text: 'yo', occurredAt: '2025-03-01T12:00:09Z' });
    h.app.actions.signOut();
    expect(lines().map((l) => l.key)).toEqual(['other']);
  });

  it('a response arriving after sign-out is ignored', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/messages', () => new Promise<Response>((r) => (release = r)));
    await send('hello');
    h.app.actions.signOut();
    release(reply(503, { error: 'UNAVAILABLE' }));
    await h.flush();
    expect(line()).toMatchObject({ unconfirmed: true, status: NOT_CONFIRMED });
    expect(h.state().sendError).toBe('');
  });
});

describe('definite failures (P8)', () => {
  beforeEach(() => signedIn());

  it('503 UNAVAILABLE removes the line, restores the text and shows the message', async () => {
    route(() => reply(503, { error: 'UNAVAILABLE' }));
    await send('hello');
    expect(lines()).toHaveLength(0);
    expect(h.state().draft).toBe('hello');
    expect(h.state().sendError).toBe('Service temporarily unavailable. Please try again.');
  });

  it('resubmitting the same text reuses the messageId; different text gets a new one', async () => {
    route(() => reply(503, { error: 'UNAVAILABLE' }), () => reply(503, { error: 'UNAVAILABLE' }), () => reply(202, {}));
    await send('hello');
    await send('hello');
    expect(posts().map((p) => JSON.parse(p.body ?? '').messageId)).toEqual([ID1, ID1]);
    await send('other');
    expect(JSON.parse(posts()[2]?.body ?? '').messageId).toBe(ID2);
  });

  it('a 202 clears the last failure so the same text gets a fresh id', async () => {
    route(() => reply(503, { error: 'UNAVAILABLE' }), () => reply(202, {}), () => reply(202, {}));
    await send('a');
    await send('b'); // 202 clears lastFailed
    await send('a');
    const ids = posts().map((p) => JSON.parse(p.body ?? '').messageId as string);
    expect(ids[0]).toBe(ID1);
    expect(ids[2]).not.toBe(ID1);
  });

  it('does not overwrite text typed meanwhile when a later attempt fails (attempts > 1)', async () => {
    route(unconfirmed503('3'), () => reply(503, { error: 'UNAVAILABLE' }));
    await send('hello');
    h.app.actions.setDraft('typing something else');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.state().draft).toBe('typing something else');
    expect(h.state().sendError).toBe('Service temporarily unavailable. Please try again.');
  });

  it('restores the text on a first-attempt failure even if the user typed meanwhile', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/messages', () => new Promise<Response>((r) => (release = r)));
    await send('hello');
    h.app.actions.setDraft('typing');
    release(reply(503, { error: 'UNAVAILABLE' }));
    await h.flush();
    expect(h.state().draft).toBe('hello');
  });

  it('restores the text on a later failure when the input is empty', async () => {
    route(unconfirmed503('3'), () => reply(503, { error: 'UNAVAILABLE' }));
    await send('hello');
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.state().draft).toBe('hello');
  });

  it('400 shows "Could not send message (HTTP n)."', async () => {
    route(() => reply(400, { error: 'INVALID_MESSAGE_ID' }));
    await send('hello');
    expect(h.state().sendError).toBe('Could not send message (HTTP 400).');
    expect(lines()).toHaveLength(0);
  });

  it('401 signs out and shows the session-expired error', async () => {
    h.deps.setGoogle(undefined); // no silent renewal available
    route(() => reply(401, { error: 'UNAUTHORIZED' }));
    await send('hello');
    expect(h.state().auth.token).toBeNull();
    expect(h.state().sendError).toBe('Your session expired. Please sign in again.');
    expect(h.state().draft).toBe('hello');
  });

  it('403 BANNED starts the ban countdown and shows no error text', async () => {
    route(() =>
      reply(403, { error: 'BANNED', bannedUntil: '2025-03-01T12:01:05Z', remainingSeconds: 65 }, { 'Retry-After': '65' }),
    );
    await send('hello');
    expect(h.state().sendError).toBe('');
    expect(h.state().ban).toEqual({ until: Date.parse('2025-03-01T12:01:05Z'), label: '1m 5s' });
    expect(h.state().draft).toBe('hello');
  });

  it('409 HANDLE_REQUIRED opens the handle dialog with no error text', async () => {
    route(() => reply(409, { error: 'HANDLE_REQUIRED' }));
    await send('hello');
    expect(h.state().dialog.open).toBe(true);
    expect(h.state().sendError).toBe('');
  });
});

describe('API base (P3)', () => {
  it('posts to messageApiBaseUrl with trailing slashes stripped', async () => {
    h = createHarness({ googleClientId: 'cid', messageApiBaseUrl: 'http://api.test//', version: '' });
    await h.bootSignedIn();
    h.deps.fakeFetch.on('POST', 'http://api.test/api/messages', () => reply(202, {}));
    await send('hello');
    expect(h.deps.fakeFetch.requestsTo('POST', 'http://api.test/api/messages')).toHaveLength(1);
  });
});
