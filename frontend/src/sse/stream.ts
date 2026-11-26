import { authHeaders, type FetchFn } from '../api/client';
import { createSseParser } from './parser';

export interface SseContext {
  fetch: FetchFn;
  setTimeout(fn: () => void, ms: number): unknown;
  getToken(): string | null;
  renewToken(): Promise<boolean>;
  signOut(): void;
}

export interface SseOptions {
  withAuth: boolean;
  onEvent(name: string, data: unknown): void;
  /** true when the stream opened, false when it ended or failed. */
  onState?(connected: boolean): void;
  /** Called right after onState(true): the stream is open first so results committed in the gap are not lost. */
  afterConnect?(): void;
  /** 403 on an authenticated stream: stops permanently, no reconnect. */
  onForbidden?(): void;
}

const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/** fetch-based SSE (EventSource cannot send Authorization or tell 401 from 403). Returns stop(). */
export function startSse(ctx: SseContext, path: string, opts: SseOptions): () => void {
  let stopped = false;
  let delay = INITIAL_DELAY_MS;
  let ctrl: AbortController | null = null;
  let retried401 = false;

  async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser(opts.onEvent);
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parser.push(decoder.decode(r.value, { stream: true }));
    }
  }

  async function run(): Promise<void> {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const accept = { Accept: 'text/event-stream' };
        const res = await ctx.fetch(path, {
          headers: opts.withAuth ? authHeaders(ctx.getToken(), accept) : accept,
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (res.status === 401 && opts.withAuth) {
          if (!retried401 && (await ctx.renewToken())) {
            retried401 = true;
            continue;
          }
          ctx.signOut();
          return;
        }
        if (res.status === 403 && opts.withAuth && opts.onForbidden) {
          stopped = true;
          opts.onForbidden();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        delay = INITIAL_DELAY_MS;
        retried401 = false;
        opts.onState?.(true);
        opts.afterConnect?.();
        await readStream(res.body);
      } catch {
        if (stopped) return;
      }
      opts.onState?.(false);
      if (stopped) return;
      await new Promise<void>((resolve) => ctx.setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  void run();
  return function stop() {
    stopped = true;
    ctrl?.abort();
  };
}
