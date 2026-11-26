import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSseStream, reply, type FakeSseStream } from '../test/fakes';
import { startSse, type SseContext, type SseOptions } from './stream';

type Responder = (signal: AbortSignal | null) => Response | Promise<Response>;

function setup(options: Partial<SseOptions> = {}, token: string | null = 'tok') {
  const responders: Responder[] = [];
  const streams: FakeSseStream[] = [];
  const fetchCalls: { url: string; init: RequestInit }[] = [];
  const calls: string[] = [];
  let currentToken = token;
  const renewToken = vi.fn(async () => true);
  const signOut = vi.fn();
  const ctx: SseContext = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init: init ?? {} });
      const next = responders.shift();
      if (!next) throw new Error('no responder queued');
      return next(init?.signal ?? null);
    }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    getToken: () => currentToken,
    renewToken,
    signOut,
  };
  const onEvent = vi.fn((name: string) => void calls.push(`event:${name}`));
  const onState = vi.fn((on: boolean) => void calls.push(`state:${on}`));
  const afterConnect = vi.fn(() => void calls.push('afterConnect'));
  const opts: SseOptions = { withAuth: false, onEvent, onState, afterConnect, ...options };
  return {
    ctx,
    opts,
    calls,
    fetchCalls,
    onEvent,
    onState,
    renewToken,
    signOut,
    setToken: (t: string | null) => void (currentToken = t),
    /** Queue a 200 stream response and return its controller. */
    queueStream(): FakeSseStream {
      let stream!: FakeSseStream;
      responders.push((signal) => {
        stream = createSseStream(signal);
        streams.push(stream);
        return stream.response;
      });
      return {
        get response() {
          return stream.response;
        },
        push: (t) => stream.push(t),
        close: () => stream.close(),
        fail: (e) => stream.fail(e),
      };
    },
    queue(responder: Responder) {
      responders.push(responder);
    },
    streams,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('startSse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests the stream without credentials on public streams', async () => {
    const t = setup();
    t.queueStream();
    startSse(t.ctx, '/api/chat/stream', t.opts);
    await flush();
    expect(t.fetchCalls[0]?.url).toBe('/api/chat/stream');
    expect(t.fetchCalls[0]?.init.headers).toEqual({ Accept: 'text/event-stream' });
    expect(t.fetchCalls[0]?.init.cache).toBe('no-store');
  });

  it('sends the bearer token on authenticated streams', async () => {
    const t = setup({ withAuth: true });
    t.queueStream();
    startSse(t.ctx, '/api/admin/stream', t.opts);
    await flush();
    expect(t.fetchCalls[0]?.init.headers).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer tok' });
  });

  it('calls onState(true) and then afterConnect when the stream opens', async () => {
    const t = setup();
    t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    expect(t.calls).toEqual(['state:true', 'afterConnect']);
  });

  it('delivers parsed events across chunks', async () => {
    const t = setup();
    const s = t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    s.push('event: message\ndata: {"messageId":"1"}\n\n:ping\n\nevent: kafka\nda');
    await flush();
    s.push('ta: {"status":"UP"}\n\n');
    await flush();
    expect(t.onEvent.mock.calls).toEqual([
      ['message', { messageId: '1' }],
      ['kafka', { status: 'UP' }],
    ]);
  });

  it('reports onState(false) when the stream ends and reconnects after the delay', async () => {
    const t = setup();
    const first = t.queueStream();
    t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    first.close();
    await flush();
    expect(t.calls).toEqual(['state:true', 'afterConnect', 'state:false']);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.fetchCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetchCalls).toHaveLength(2);
    expect(t.calls.slice(-2)).toEqual(['state:true', 'afterConnect']);
  });

  it('doubles the delay on repeated failures up to 30s', async () => {
    const t = setup();
    for (let i = 0; i < 9; i++) t.queue(() => reply(500));
    startSse(t.ctx, '/s', t.opts);
    await flush();
    expect(t.fetchCalls).toHaveLength(1);
    for (const [i, wait] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(t.fetchCalls, `before wait ${i}`).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.fetchCalls, `after wait ${i}`).toHaveLength(i + 2);
    }
    expect(t.onState).not.toHaveBeenCalledWith(true);
  });

  it('resets the delay after a successful connection', async () => {
    const t = setup();
    t.queue(() => reply(500));
    t.queue(() => reply(500));
    const ok = t.queueStream();
    t.queue(() => reply(500));
    startSse(t.ctx, '/s', t.opts);
    await flush();
    await vi.advanceTimersByTimeAsync(1000); // 2nd attempt (fails, delay now 4000 next)
    await vi.advanceTimersByTimeAsync(2000); // 3rd attempt succeeds
    expect(t.fetchCalls).toHaveLength(3);
    ok.close();
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(t.fetchCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); // back to 1s, not 4s
    expect(t.fetchCalls).toHaveLength(4);
  });

  it('treats a rejected fetch, a missing body and a mid-stream error as connection loss', async () => {
    const t = setup();
    t.queue(() => Promise.reject(new TypeError('Failed to fetch')));
    t.queue(() => new Response(null, { status: 200 }));
    const s = t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    expect(t.calls).toEqual(['state:false']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls).toEqual(['state:false', 'state:false']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.calls.slice(2)).toEqual(['state:true', 'afterConnect']);
    s.fail();
    await flush();
    expect(t.calls.at(-1)).toBe('state:false');
  });

  it('renews once on 401 and reconnects immediately', async () => {
    const t = setup({ withAuth: true });
    t.queue(() => reply(401));
    t.queueStream();
    startSse(t.ctx, '/api/admin/stream', t.opts);
    await flush();
    expect(t.renewToken).toHaveBeenCalledTimes(1);
    expect(t.fetchCalls).toHaveLength(2);
    expect(t.signOut).not.toHaveBeenCalled();
    expect(t.calls).toEqual(['state:true', 'afterConnect']);
  });

  it('signs out when the renewed stream is rejected again, and stops', async () => {
    const t = setup({ withAuth: true });
    t.queue(() => reply(401));
    t.queue(() => reply(401));
    startSse(t.ctx, '/api/admin/stream', t.opts);
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.renewToken).toHaveBeenCalledTimes(1);
    expect(t.signOut).toHaveBeenCalledTimes(1);
    expect(t.fetchCalls).toHaveLength(2);
    expect(t.onState).not.toHaveBeenCalled();
  });

  it('signs out immediately when renewal fails', async () => {
    const t = setup({ withAuth: true });
    t.renewToken.mockResolvedValueOnce(false);
    t.queue(() => reply(401));
    startSse(t.ctx, '/api/admin/stream', t.opts);
    await vi.advanceTimersByTimeAsync(60000);
    expect(t.signOut).toHaveBeenCalledTimes(1);
    expect(t.fetchCalls).toHaveLength(1);
  });

  it('allows another renewal after a successful connection', async () => {
    const t = setup({ withAuth: true });
    t.queue(() => reply(401));
    const ok = t.queueStream();
    t.queue(() => reply(401));
    t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    ok.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.renewToken).toHaveBeenCalledTimes(2);
    expect(t.signOut).not.toHaveBeenCalled();
    expect(t.fetchCalls).toHaveLength(4);
  });

  it('does not renew or sign out on a 401 from a public stream; it just reconnects', async () => {
    const t = setup({ withAuth: false });
    t.queue(() => reply(401));
    t.queueStream();
    startSse(t.ctx, '/api/chat/stream', t.opts);
    await flush();
    expect(t.renewToken).not.toHaveBeenCalled();
    expect(t.calls).toEqual(['state:false']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.calls.slice(1)).toEqual(['state:true', 'afterConnect']);
  });

  it('403 calls onForbidden once and never reconnects', async () => {
    const onForbidden = vi.fn();
    const t = setup({ withAuth: true, onForbidden });
    t.queue(() => reply(403));
    startSse(t.ctx, '/api/admin/stream', t.opts);
    await vi.advanceTimersByTimeAsync(120000);
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(t.fetchCalls).toHaveLength(1);
    expect(t.onState).not.toHaveBeenCalled();
    expect(t.signOut).not.toHaveBeenCalled();
  });

  it('403 without onForbidden is an ordinary failure with reconnect', async () => {
    const t = setup({ withAuth: true });
    t.queue(() => reply(403));
    t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    expect(t.calls).toEqual(['state:false']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.fetchCalls).toHaveLength(2);
  });

  it('stop() aborts the open request and silences state callbacks', async () => {
    const t = setup();
    t.queueStream();
    const stop = startSse(t.ctx, '/s', t.opts);
    await flush();
    const signal = t.fetchCalls[0]?.init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    stop();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(t.calls).toEqual(['state:true', 'afterConnect']);
    await vi.advanceTimersByTimeAsync(120000);
    expect(t.fetchCalls).toHaveLength(1);
  });

  it('stop() during the reconnect delay prevents the next attempt', async () => {
    const t = setup();
    const s = t.queueStream();
    t.queueStream();
    const stop = startSse(t.ctx, '/s', t.opts);
    await flush();
    s.close();
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(120000);
    expect(t.fetchCalls).toHaveLength(1);
  });

  it('uses a fresh AbortController per attempt', async () => {
    const t = setup();
    const s = t.queueStream();
    t.queueStream();
    startSse(t.ctx, '/s', t.opts);
    await flush();
    s.close();
    await vi.advanceTimersByTimeAsync(1000);
    const [a, b] = t.fetchCalls.map((c) => c.init.signal);
    expect(a).not.toBe(b);
  });
});
