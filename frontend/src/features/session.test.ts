import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reply } from '../test/fakes';
import { createHarness, emit, fakeJwt, meResponse, type Harness } from '../test/harness';

const NOW = new Date('2025-03-01T12:00:00Z');
const nowSec = () => Math.floor(NOW.getTime() / 1000);
let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h = createHarness();
});
afterEach(() => {
  vi.useRealTimers();
});

const meCalls = () => h.deps.fakeFetch.requestsTo('GET', '/api/me');
const prompts = () => h.deps.fakeGoogle.prompt.mock.calls.length;

describe('token storage (S1)', () => {
  it('stores the credential in session storage and removes it on sign-out', async () => {
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(200, meResponse()));
    await h.boot();
    h.deps.fakeGoogle.deliverCredential('tok-1');
    await h.flush();
    expect(h.deps.storage.data.get('idToken')).toBe('tok-1');
    expect(h.state().auth.token).toBe('tok-1');
    h.app.actions.signOut();
    expect(h.deps.storage.data.has('idToken')).toBe(false);
    expect(h.state().auth.token).toBeNull();
  });

  it('swallows storage errors', async () => {
    h.deps.storage.getItem = () => {
      throw new Error('blocked');
    };
    h.deps.storage.setItem = () => {
      throw new Error('blocked');
    };
    h.deps.storage.removeItem = () => {
      throw new Error('blocked');
    };
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(200, meResponse()));
    await h.boot();
    h.deps.fakeGoogle.deliverCredential('tok-1');
    await h.flush();
    expect(h.state().auth.me?.handle).toBe('alice');
    expect(() => h.app.actions.signOut()).not.toThrow();
  });
});

describe('renewal timer (S2)', () => {
  it('renews 5 minutes before the token expires', async () => {
    await h.bootSignedIn(meResponse(), fakeJwt(nowSec() + 10 * 60));
    expect(prompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(prompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(prompts()).toBe(1);
  });

  it('renews immediately when already within 5 minutes of expiry', async () => {
    await h.bootSignedIn(meResponse(), fakeJwt(nowSec() + 60));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompts()).toBe(1);
  });

  it('sets no timer for a token without exp', async () => {
    await h.bootSignedIn(meResponse(), fakeJwt());
    await vi.advanceTimersByTimeAsync(3 * 3600 * 1000);
    expect(prompts()).toBe(0);
  });

  it('caps the delay at the largest setTimeout value', async () => {
    const spy = vi.spyOn(h.deps, 'setTimeout');
    await h.bootSignedIn(meResponse(), fakeJwt(nowSec() + 10 * 365 * 24 * 3600));
    expect(spy.mock.calls.map((c) => c[1])).toContain(2147483647);
  });

  it('is cancelled by sign-out', async () => {
    await h.bootSignedIn(meResponse(), fakeJwt(nowSec() + 10 * 60));
    h.app.actions.signOut();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(prompts()).toBe(0);
  });
});

describe('renewToken (S3)', () => {
  // the token is still valid for a long time, so only explicit calls prompt
  beforeEach(async () => {
    h.withSavedSession(meResponse(), fakeJwt(nowSec() + 3600));
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(401, {}));
  });

  async function startRenewal(): Promise<void> {
    // an authenticated call that gets 401 triggers a renewal; start() stays pending until it settles
    void h.app.start(h.button);
    await h.flush();
  }

  it('shares one in-flight renewal and signs out when Google declines', async () => {
    await startRenewal();
    expect(prompts()).toBe(1);
    h.deps.fakeGoogle.notify({ isNotDisplayed: () => true });
    await h.flush();
    expect(h.state().auth.token).toBeNull();
  });

  it('is false when the moment was skipped', async () => {
    await startRenewal();
    h.deps.fakeGoogle.notify({ isSkippedMoment: () => true });
    await h.flush();
    expect(h.state().auth.token).toBeNull();
  });

  it('is false after 8 seconds without an answer', async () => {
    await startRenewal();
    await vi.advanceTimersByTimeAsync(7999);
    expect(h.state().auth.token).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state().auth.token).toBeNull();
  });

  it('is false when prompt throws', async () => {
    h.deps.fakeGoogle.prompt.mockImplementation(() => {
      throw new Error('boom');
    });
    await startRenewal();
    expect(h.state().auth.token).toBeNull();
  });

  it('is false immediately without Google', async () => {
    h.deps.setGoogle(undefined);
    await startRenewal();
    expect(h.state().auth.token).toBeNull();
    expect(prompts()).toBe(0);
  });

  it('S4/S5 is true when a credential arrives meanwhile: the request is retried once with the new token', async () => {
    let calls = 0;
    h.deps.fakeFetch.on('GET', '/api/me', (req) => {
      calls++;
      return calls === 1 ? reply(401, {}) : reply(200, { ...meResponse(), email: req.headers.Authorization ?? '' });
    });
    await startRenewal();
    h.deps.fakeGoogle.deliverCredential('fresh');
    await h.flush();
    expect(meCalls().map((r) => r.headers.Authorization)).toEqual([
      expect.stringMatching(/^Bearer h\./),
      'Bearer fresh', // the retry
      'Bearer fresh', // onCredential also refreshes: no profile was loaded yet
    ]);
    expect(h.state().auth.token).toBe('fresh');
    expect(h.state().auth.me?.email).toBe('Bearer fresh');
  });

  it('S4 a second 401 after the renewal is not retried again', async () => {
    await startRenewal();
    h.deps.fakeGoogle.deliverCredential('fresh');
    await h.flush();
    // original + one retry (+ the refresh onCredential starts because no profile was loaded); never a second retry
    expect(meCalls()).toHaveLength(3);
    expect(h.state().auth.token).toBeNull(); // 401 on the retry signs out
  });
});

describe('onCredential (S5)', () => {
  beforeEach(async () => {
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(200, meResponse()));
    await h.boot();
  });

  it('ignores a response without credential', async () => {
    h.deps.fakeGoogle.deliverCredential('');
    await h.flush();
    expect(h.state().auth.token).toBeNull();
    expect(meCalls()).toHaveLength(0);
  });

  it('loads the profile only when none is loaded yet', async () => {
    h.deps.fakeGoogle.deliverCredential('a');
    await h.flush();
    expect(meCalls()).toHaveLength(1);
    h.deps.fakeGoogle.deliverCredential('b');
    await h.flush();
    expect(meCalls()).toHaveLength(1);
    expect(h.state().auth.token).toBe('b');
  });
});

describe('refreshMe (S6)', () => {
  it('does nothing without a token', async () => {
    await h.boot();
    expect(meCalls()).toHaveLength(0);
  });

  it('a 401 signs out', async () => {
    h.deps.setGoogle(undefined);
    h.withSavedSession();
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(401, {}));
    await h.boot();
    expect(h.state().auth).toMatchObject({ token: null, me: null });
    expect(h.deps.storage.data.has('idToken')).toBe(false);
  });

  it('shows the profile error on a non-OK response during boot', async () => {
    h.withSavedSession();
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(503, {}));
    await h.boot();
    expect(h.state().sendError).toBe('Could not load your profile. Try again shortly.');
    expect(h.state().auth.token).not.toBeNull();
    expect(h.state().auth.me).toBeNull();
  });

  it('shows the profile error on a network failure', async () => {
    h.withSavedSession();
    h.deps.fakeFetch.on('GET', '/api/me', () => {
      throw new Error('offline');
    });
    await h.boot();
    expect(h.state().sendError).toBe('Could not load your profile. Try again shortly.');
  });

  it('opens the handle dialog when the profile has no handle', async () => {
    await h.bootSignedIn(meResponse({ handle: null }));
    expect(h.state().dialog.open).toBe(true);
  });

  it('keeps the old profile when a later refresh fails', async () => {
    await h.bootSignedIn();
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(500, {}));
    h.deps.fakeFetch.on('POST', '/api/messages', () => reply(202, {}));
    h.app.actions.setDraft('x');
    h.app.actions.submit();
    await h.flush();
    await emit(h.publicStreams[0], 'removed', { messageId: '00000000-0000-4000-8000-000000000001', handle: 'alice' });
    expect(h.state().sendError).toBe('Could not load your profile. Try again shortly.');
    expect(h.state().auth.me?.handle).toBe('alice');
  });
});

describe('signOut (S7)', () => {
  it('sends DELETE presence with keepalive while presence runs, then clears everything', async () => {
    await h.bootSignedIn();
    expect(h.state().presence.running).toBe(true);
    const token = h.state().auth.token;
    h.app.actions.signOut();
    const del = h.deps.fakeFetch.requestsTo('DELETE', '/api/me/presence');
    expect(del).toHaveLength(1);
    expect(del[0]?.headers.Authorization).toBe(`Bearer ${token}`);
    expect(h.state().presence.running).toBe(false);
    expect(h.state().auth).toMatchObject({ token: null, me: null });
    expect(h.deps.fakeGoogle.disableAutoSelect).toHaveBeenCalledTimes(1);
  });

  it('does not send DELETE presence without a handle (presence never started)', async () => {
    await h.bootSignedIn(meResponse({ handle: null }));
    h.app.actions.signOut();
    expect(h.deps.fakeFetch.requestsTo('DELETE', '/api/me/presence')).toHaveLength(0);
  });

  it('does not clear the chat lines', async () => {
    await h.bootSignedIn();
    await emit(h.publicStreams[0], 'message', { messageId: 'm1', handle: 'bob', text: 'hi', occurredAt: '2025-03-01T12:00:00Z' });
    h.app.actions.signOut();
    expect(h.state().lines).toHaveLength(1);
  });

  it('survives a throwing DELETE and a missing Google', async () => {
    await h.bootSignedIn();
    h.deps.fakeFetch.on('DELETE', '/api/me/presence', () => {
      throw new Error('offline');
    });
    h.deps.setGoogle(undefined);
    expect(() => h.app.actions.signOut()).not.toThrow();
    await h.flush();
    expect(h.state().auth.token).toBeNull();
  });
});

describe('syncMe (M1-M5)', () => {
  it('M2 warns with the threshold for users, without it for admins, and not while banned', async () => {
    await h.bootSignedIn(meResponse({ warning: true, strikes: 2, banThreshold: 3 }));
    expect(h.state().warnText).toBe('You have 2 flagged messages. At 3 your account is temporarily banned.');
    h.app.actions.signOut();
    expect(h.state().warnText).toBeNull();
  });

  it('M2 admins get the short warning', async () => {
    await h.bootSignedIn(meResponse({ warning: true, strikes: 2, isAdmin: true }));
    expect(h.state().warnText).toBe('You have 2 flagged messages.');
  });

  it('M2 no warning while banned', async () => {
    const ban = { until: new Date(NOW.getTime() + 60_000).toISOString(), remainingSeconds: 60 };
    await h.bootSignedIn(meResponse({ warning: true, strikes: 2, ban }));
    expect(h.state().warnText).toBeNull();
  });

  it('M3 starts the ban countdown from me.ban', async () => {
    const ban = { until: new Date(NOW.getTime() + 65_000).toISOString(), remainingSeconds: 65 };
    await h.bootSignedIn(meResponse({ ban }));
    expect(h.state().ban).toEqual({ until: NOW.getTime() + 65_000, label: '1m 5s' });
  });

  it('M4 an admin starts the admin stream once', async () => {
    await h.bootSignedIn(meResponse({ isAdmin: true }));
    expect(h.adminStreams).toHaveLength(1);
    h.app.actions.signOut();
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/admin/stream')[0]?.signal?.aborted).toBe(true);
  });

  it('M4 a non-admin never opens the admin stream and is switched back to the chat tab', async () => {
    await h.bootSignedIn();
    expect(h.adminStreams).toHaveLength(0);
    expect(h.state().admin.tab).toBe('chat');
  });

  it('M5 presence starts only with a handle', async () => {
    await h.bootSignedIn(meResponse({ handle: null }));
    expect(h.state().presence.running).toBe(false);
    expect(h.deps.fakeFetch.requestsTo('POST', '/api/me/presence')).toHaveLength(0);
  });
});
