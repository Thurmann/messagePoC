import { vi } from 'vitest';
import type { MeResponse } from '../api/types';
import { createApp, type App } from '../core/app';
import type { AppState } from '../core/state';
import { createFakeDeps, createSseStream, reply, type FakeDeps, type FakeSseStream } from './fakes';

/** An unsigned JWT-shaped token whose payload carries `exp` (seconds). */
export function fakeJwt(expSeconds?: number): string {
  const payload = btoa(JSON.stringify(expSeconds === undefined ? {} : { exp: expSeconds }));
  return `h.${payload.replace(/=+$/, '')}.s`;
}

export function meResponse(patch: Partial<MeResponse> = {}): MeResponse {
  return {
    email: 'alice@example.com',
    handle: 'alice',
    isAdmin: false,
    strikes: 0,
    warningThreshold: 2,
    banThreshold: 3,
    warning: false,
    ban: null,
    ...patch,
  };
}

export interface Harness {
  deps: FakeDeps;
  app: App;
  button: HTMLElement;
  publicStreams: FakeSseStream[];
  adminStreams: FakeSseStream[];
  state(): AppState;
  /** Let pending promises and 0ms timers run. */
  flush(): Promise<void>;
  /** Store a token as a previous visit would have, and make GET /api/me answer with `me`. */
  withSavedSession(me?: MeResponse, token?: string): void;
  boot(): Promise<void>;
  /** Boot with a saved session and wait until it settles. */
  bootSignedIn(me?: MeResponse, token?: string): Promise<void>;
  urls(method?: string): string[];
}

/** An app wired to the fake fetch router with happy-path defaults for every endpoint. Call vi.useFakeTimers() first. */
export function createHarness(config = { googleClientId: 'cid', messageApiBaseUrl: '', version: '1.2.3' }): Harness {
  const deps = createFakeDeps();
  const f = deps.fakeFetch;
  const publicStreams: FakeSseStream[] = [];
  const adminStreams: FakeSseStream[] = [];
  const streamRoute = (list: FakeSseStream[]) => (req: { signal: AbortSignal | null }) => {
    const s = createSseStream(req.signal);
    list.push(s);
    return s.response;
  };
  f.on('GET', '/api/config', () => reply(200, config));
  f.on('GET', '/api/chat/stream', streamRoute(publicStreams));
  f.on('GET', '/api/admin/stream', streamRoute(adminStreams));
  f.on('GET', '/api/chat/kafka-status', () => reply(200, { status: 'UP', since: null, checkedAt: null }));
  f.on('GET', '/api/chat/history', () => reply(200, []));
  f.on('POST', '/api/me/presence', () => reply(200, { ban: null }));
  f.on('DELETE', '/api/me/presence', () => reply(204));
  f.on('GET', '/api/users/online', () => reply(200, []));
  f.on('GET', '/api/admin/moderation-log', () => reply(200, []));
  f.on('POST', '/api/messages', () => reply(202, { status: 'PENDING' }));

  const app = createApp(deps);
  const button = document.createElement('div');
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };
  const h: Harness = {
    deps,
    app,
    button,
    publicStreams,
    adminStreams,
    state: () => app.store.get(),
    flush,
    withSavedSession(me = meResponse(), token = fakeJwt()) {
      deps.storage.setItem('idToken', token);
      f.on('GET', '/api/me', () => reply(200, me));
    },
    boot: async () => {
      await app.start(button);
      await flush();
    },
    bootSignedIn: async (me, token) => {
      h.withSavedSession(me, token);
      await h.boot();
    },
    urls: (method) => f.requests.filter((r) => !method || r.method === method).map((r) => r.url),
  };
  return h;
}

/** Push one SSE event into a stream and let the app process it. */
export async function emit(stream: FakeSseStream | undefined, name: string, data: unknown): Promise<void> {
  stream?.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  await vi.advanceTimersByTimeAsync(0);
}
