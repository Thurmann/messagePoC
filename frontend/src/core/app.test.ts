import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reply } from '../test/fakes';
import { createHarness, meResponse, type Harness } from '../test/harness';
import { composerView, connView, sessionView, versionView } from './selectors';

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-03-01T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('boot (B1-B4)', () => {
  it('B4 runs config, public stream, kafka status, Google script, then the profile', async () => {
    h = createHarness();
    const order: string[] = [];
    h.deps.loadScript.mockImplementation(async (src) => {
      order.push(`script:${src}`);
      order.push(...h.urls().map((u) => `fetch:${u}`));
    });
    h.withSavedSession();
    await h.boot();
    expect(order[0]).toBe('script:https://accounts.google.com/gsi/client');
    expect(order.slice(1)).toEqual(['fetch:/api/config', 'fetch:/api/chat/stream', 'fetch:/api/chat/kafka-status']);
    expect(h.urls().indexOf('/api/me')).toBeGreaterThan(h.urls().indexOf('/api/chat/kafka-status'));
    expect(h.deps.fakeGoogle.initialize).toHaveBeenCalledTimes(1);
    expect(h.state().auth.me?.handle).toBe('alice');
  });

  it('B1 a first-time visitor sees a disabled "Sign in to chat" composer and "offline" without a class', async () => {
    h = createHarness();
    await h.boot();
    expect(composerView(h.state())).toEqual({ disabled: true, placeholder: 'Sign in to chat' });
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/me')).toHaveLength(0);
  });

  it('B1 offline until the first stream result', async () => {
    h = createHarness();
    h.deps.fakeFetch.on('GET', '/api/chat/stream', () => new Promise<Response>(() => undefined));
    await h.boot();
    expect(connView(h.state())).toMatchObject({ text: 'offline', className: '' });
  });

  it('B2 requests the config uncached and shows the version', async () => {
    h = createHarness();
    await h.boot();
    const req = h.deps.fakeFetch.requestsTo('GET', '/api/config')[0];
    expect(req).toBeDefined();
    expect(h.deps.fakeFetch.fetch).toHaveBeenCalledWith('/api/config', { cache: 'no-store' });
    expect(versionView(h.state())).toEqual({ visible: true, text: 'v1.2.3', title: 'Running version 1.2.3' });
  });

  it.each([
    ['a non-OK answer', () => reply(500, {})],
    [
      'a network error',
      () => {
        throw new Error('offline');
      },
    ],
  ])('B2 falls back to defaults on %s', async (_name, respond) => {
    h = createHarness();
    h.deps.fakeFetch.on('GET', '/api/config', respond);
    await h.boot();
    expect(h.state().config).toEqual({ googleClientId: '', messageApiBaseUrl: '', version: '' });
    expect(versionView(h.state()).visible).toBe(false);
    expect(h.state().auth.setupNotice).toBe('Set GOOGLE_CLIENT_ID to enable sign-in');
  });

  it('B3 starts the public stream and loads the Kafka status once, even before the stream answers', async () => {
    h = createHarness();
    h.deps.fakeFetch.on('GET', '/api/chat/stream', () => new Promise<Response>(() => undefined));
    await h.boot();
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/chat/stream')).toHaveLength(1);
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/chat/kafka-status')).toHaveLength(1);
  });
});

describe('Google sign-in (G1-G4)', () => {
  it('G1 without a client id shows the setup notice, loads no script and hides the login', async () => {
    h = createHarness({ googleClientId: '', messageApiBaseUrl: '', version: '' });
    await h.boot();
    expect(h.state().auth.setupNotice).toBe('Set GOOGLE_CLIENT_ID to enable sign-in');
    expect(h.deps.loadScript).not.toHaveBeenCalled();
    expect(sessionView(h.state()).showLogin).toBe(false);
  });

  it('G2 loads the script, initializes with auto_select and renders the button', async () => {
    h = createHarness();
    await h.boot();
    expect(h.deps.loadScript).toHaveBeenCalledWith('https://accounts.google.com/gsi/client');
    expect(h.deps.fakeGoogle.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: 'cid', auto_select: true, callback: expect.any(Function) }),
    );
    expect(h.deps.fakeGoogle.renderButton).toHaveBeenCalledWith(h.button, {
      theme: 'outline',
      size: 'medium',
      type: 'standard',
    });
    expect(h.state().auth.setupNotice).toBeNull();
  });

  it('G2 looks #gsi-button up when no element is passed', async () => {
    h = createHarness();
    const el = document.createElement('div');
    el.id = 'gsi-button';
    document.body.appendChild(el);
    await h.app.start();
    expect(h.deps.fakeGoogle.renderButton).toHaveBeenCalledWith(el, expect.anything());
  });

  it('G3 a script that fails to load shows "Could not load Google sign-in."', async () => {
    h = createHarness();
    h.deps.loadScript.mockRejectedValue(new Error('blocked'));
    await h.boot();
    expect(h.state().auth.setupNotice).toBe('Could not load Google sign-in.');
    expect(sessionView(h.state()).showLogin).toBe(false);
  });

  it('G3 a script that loads without defining Google shows the same notice', async () => {
    h = createHarness();
    h.deps.setGoogle(undefined);
    await h.boot();
    expect(h.state().auth.setupNotice).toBe('Could not load Google sign-in.');
  });

  it('G3 a missing button element shows the same notice', async () => {
    h = createHarness();
    await h.app.start(null);
    expect(h.state().auth.setupNotice).toBe('Could not load Google sign-in.');
  });

  it('G4 the login is visible only while signed out with Google ready', async () => {
    h = createHarness();
    await h.boot();
    expect(sessionView(h.state()).showLogin).toBe(true);
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(200, meResponse()));
    h.deps.fakeGoogle.deliverCredential('tok');
    await h.flush();
    expect(sessionView(h.state()).showLogin).toBe(false);
    h.app.actions.signOut();
    expect(sessionView(h.state()).showLogin).toBe(true);
  });

  it('G4 stays hidden during boot while a saved session loads, and appears if loading fails', async () => {
    h = createHarness();
    h.withSavedSession();
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('GET', '/api/me', () => new Promise<Response>((r) => (release = r)));
    const booting = h.app.start(h.button);
    await h.flush();
    expect(sessionView(h.state()).showLogin).toBe(false);
    release(reply(503, {}));
    await booting;
    expect(sessionView(h.state()).showLogin).toBe(true);
  });
});
