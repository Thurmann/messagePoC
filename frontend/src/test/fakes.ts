import { vi, type Mock } from 'vitest';
import type { Deps, Google, GoogleMomentNotification } from '../core/deps';
import type { StorageLike } from '../lib/storage';

// ---------- fake fetch router ----------

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null;
}

export type RouteReply = Response | { status?: number; json?: unknown; headers?: Record<string, string> };
type Handler = (req: RecordedRequest) => RouteReply | Promise<RouteReply>;

export function reply(status: number, json?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(json === undefined ? null : JSON.stringify(json), {
    status: status === 204 ? 204 : status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function toResponse(r: RouteReply): Response {
  return r instanceof Response ? r : reply(r.status ?? 200, r.json, r.headers);
}

export interface FakeFetch {
  fetch: Mock<(input: string, init?: RequestInit) => Promise<Response>>;
  requests: RecordedRequest[];
  /** Register a handler for METHOD + path (string = exact path without query, RegExp tests the full url). Later wins. */
  on(method: string, path: string | RegExp, handler: Handler | RouteReply): void;
  requestsTo(method: string, path: string): RecordedRequest[];
}

export function createFakeFetch(): FakeFetch {
  const routes: { method: string; path: string | RegExp; handler: Handler }[] = [];
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    const req: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: input,
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === 'string' ? init.body : null,
      signal: init.signal ?? null,
    };
    requests.push(req);
    const route = [...routes]
      .reverse()
      .find(
        (r) =>
          r.method === req.method &&
          (typeof r.path === 'string' ? r.path === req.url.split('?')[0] : r.path.test(req.url)),
      );
    if (!route) return reply(404, { error: 'NO_ROUTE' });
    return toResponse(await route.handler(req));
  });
  return {
    fetch,
    requests,
    on(method, path, handler) {
      routes.push({
        method: method.toUpperCase(),
        path,
        handler: typeof handler === 'function' ? handler : () => handler,
      });
    },
    requestsTo: (method, path) =>
      requests.filter((r) => r.method === method.toUpperCase() && r.url.split('?')[0] === path),
  };
}

// ---------- controllable SSE body ----------

export interface FakeSseStream {
  response: Response;
  push(text: string): void;
  close(): void;
  fail(error?: Error): void;
}

/** A 200 text/event-stream response whose body the test feeds by hand. Aborting the request signal errors the body. */
export function createSseStream(signal?: AbortSignal | null): FakeSseStream {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  signal?.addEventListener('abort', () => {
    try {
      ctrl.error(new DOMException('Aborted', 'AbortError'));
    } catch {
      /* already closed */
    }
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (text) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
    fail: (error = new Error('network down')) => ctrl.error(error),
  };
}

// ---------- fake Google Identity Services ----------

export interface FakeGoogle {
  google: Google;
  initialize: Mock;
  renderButton: Mock;
  prompt: Mock;
  disableAutoSelect: Mock;
  /** Invoke the callback given to initialize(), as Google does after a sign-in. */
  deliverCredential(credential: string): void;
  /** Run the listener given to the latest prompt() with a moment notification. */
  notify(notification: GoogleMomentNotification): void;
}

export function createFakeGoogle(): FakeGoogle {
  let callback: (resp: { credential?: string }) => void = () => undefined;
  let listener: ((n: GoogleMomentNotification) => void) | undefined;
  const initialize = vi.fn((config: { callback: typeof callback }) => {
    callback = config.callback;
  });
  const renderButton = vi.fn();
  const prompt = vi.fn((l?: (n: GoogleMomentNotification) => void) => {
    listener = l;
  });
  const disableAutoSelect = vi.fn();
  return {
    google: { accounts: { id: { initialize, renderButton, prompt, disableAutoSelect } } },
    initialize,
    renderButton,
    prompt,
    disableAutoSelect,
    deliverCredential: (credential) => callback({ credential }),
    notify: (n) => listener?.(n),
  };
}

// ---------- fake deps ----------

export function createMemoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

export interface FakeDeps extends Deps {
  fakeFetch: FakeFetch;
  fakeGoogle: FakeGoogle;
  storage: ReturnType<typeof createMemoryStorage>;
  confirm: Mock<(message: string) => boolean>;
  loadScript: Mock<(src: string) => Promise<void>>;
  /** Pass undefined to simulate Google not being loaded. */
  setGoogle(google: Google | undefined): void;
}

/**
 * Deps backed by the global timers and Date, so `vi.useFakeTimers()` (called by the test, before or after
 * creation) controls time. Fetch is the recording router; Google and storage are in-memory fakes.
 */
export function createFakeDeps(): FakeDeps {
  const fakeFetch = createFakeFetch();
  const fakeGoogle = createFakeGoogle();
  const storage = createMemoryStorage();
  let google: Google | undefined = fakeGoogle.google;
  let uuid = 0;
  return {
    fakeFetch,
    fakeGoogle,
    storage,
    fetch: fakeFetch.fetch,
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as number),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as number),
    session: storage,
    confirm: vi.fn(() => true),
    getGoogle: () => google,
    loadScript: vi.fn(async () => undefined),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    setGoogle(next) {
      google = next;
    },
  };
}
