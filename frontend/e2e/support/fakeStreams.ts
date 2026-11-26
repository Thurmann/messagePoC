import { expect, type Page } from '@playwright/test';

export type StreamKey = 'chat' | 'admin';
/** 'ok' opens a controllable stream, a number answers with that HTTP status, 'error' rejects like a network
 *  failure and 'hang' never answers until the request is aborted. */
export type StreamMode = 'ok' | 'error' | 'hang' | number;

export interface StreamRequest {
  key: StreamKey;
  accept: string | null;
  authorization: string | null;
}

const PATHS = { chat: '/api/chat/stream', admin: '/api/admin/stream' } as const;

// Installed with addInitScript, so it is in place before the app's first fetch. Only the two stream endpoints
// are replaced; every other request goes to the real fetch (and from there to page.route).
function installShim(): void {
  const w = window as unknown as Record<string, any>;
  if (w.__sse) return;
  const sse = {
    modes: { chat: 'ok', admin: 'ok' } as Record<string, unknown>,
    requests: [] as unknown[],
    conns: { chat: [] as any[], admin: [] as any[] },
  };
  w.__sse = sse;
  const realFetch = window.fetch.bind(window);
  const enc = new TextEncoder();
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.href).pathname;
    const key = path === '/api/chat/stream' ? 'chat' : path === '/api/admin/stream' ? 'admin' : null;
    if (!key) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    sse.requests.push({ key, accept: headers.get('Accept'), authorization: headers.get('Authorization') });
    const mode = sse.modes[key];
    const signal = init?.signal;
    const aborted = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');
    if (mode === 'error') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode === 'hang') {
      return new Promise((_resolve, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(aborted()));
      });
    }
    if (typeof mode === 'number') return Promise.resolve(new Response('', { status: mode }));
    const conn: { controller?: ReadableStreamDefaultController<Uint8Array>; open: boolean } = { open: true };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        conn.controller = controller;
      },
    });
    sse.conns[key].push(conn);
    if (signal) {
      signal.addEventListener('abort', () => {
        if (!conn.open) return;
        conn.open = false;
        conn.controller?.error(aborted());
      });
    }
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
  };
  w.__sseSend = (key: string, text: string): void => {
    const live = sse.conns[key as StreamKey].filter((c: { open: boolean }) => c.open);
    const conn = live[live.length - 1];
    if (!conn) throw new Error(`no open ${key} stream`);
    conn.controller.enqueue(enc.encode(text));
  };
  w.__sseDrop = (key: string): void => {
    for (const conn of sse.conns[key as StreamKey]) {
      if (!conn.open) continue;
      conn.open = false;
      conn.controller.close();
    }
  };
}

/** Controls the fake server-sent-event streams of one page. */
export class FakeStreams {
  constructor(
    private readonly page: Page,
    private readonly enabled: boolean,
  ) {}

  async install(): Promise<void> {
    if (this.enabled) await this.page.addInitScript(installShim);
  }

  /** Sets how the next stream requests of `key` are answered; applies to the current and to later page loads. */
  async setMode(key: StreamKey, mode: StreamMode): Promise<void> {
    // The shim comes from an earlier init script, so it exists when this one runs on each page load.
    const apply = ([k, m]: readonly [StreamKey, StreamMode]): void => {
      (window as unknown as { __sse: { modes: Record<string, unknown> } }).__sse.modes[k] = m;
    };
    await this.page.addInitScript(apply, [key, mode] as const);
    try {
      await this.page.evaluate(apply, [key, mode] as const);
    } catch {
      /* no page loaded yet: the init script covers the first load */
    }
  }

  /** The stream requests the app has made for `key`, oldest first. */
  async requests(key: StreamKey): Promise<StreamRequest[]> {
    const all = await this.page.evaluate(
      () => (window as unknown as { __sse: { requests: StreamRequest[] } }).__sse.requests,
    );
    return all.filter((r) => r.key === key);
  }

  /** Waits until the app has an open stream of `key` (the count of live connections reaches `atLeast`). */
  async waitOpen(key: StreamKey, atLeast = 1): Promise<void> {
    await expect
      .poll(
        () =>
          this.page.evaluate(
            (k) =>
              (window as unknown as { __sse: { conns: Record<string, Array<{ open: boolean }>> } }).__sse.conns[
                k
              ]!.filter((c) => c.open).length,
            key,
          ),
        { message: `open ${key} stream` },
      )
      .toBeGreaterThanOrEqual(atLeast);
  }

  /** Sends one event on the newest open stream. */
  async push(key: StreamKey, event: string, data: unknown): Promise<void> {
    await this.raw(key, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Writes raw bytes on the newest open stream. */
  async raw(key: StreamKey, text: string): Promise<void> {
    await this.waitOpen(key);
    await this.page.evaluate(([k, t]) => (window as any).__sseSend(k, t), [key, text] as const);
  }

  /** Ends every open stream of `key` normally, as a server restart or proxy timeout would. */
  async drop(key: StreamKey): Promise<void> {
    await this.page.evaluate((k) => (window as any).__sseDrop(k), key);
  }
}
