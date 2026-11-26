import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnlineUser } from '../api/types';
import { usersView } from '../core/selectors';
import { reply } from '../test/fakes';
import { createHarness, meResponse, type Harness } from '../test/harness';

const NOW = new Date('2025-03-01T12:00:00Z');
let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h = createHarness();
});
afterEach(() => {
  vi.useRealTimers();
});

const beats = () => h.deps.fakeFetch.requestsTo('POST', '/api/me/presence');
const polls = () => h.deps.fakeFetch.requestsTo('GET', '/api/users/online');
const online = (users: OnlineUser[]) => h.deps.fakeFetch.on('GET', '/api/users/online', () => reply(200, users));
const view = () => usersView(h.state());

describe('heartbeat and polling (R1, R2)', () => {
  it('R1 beats and polls once on start, then beats every 30s and polls every 15s', async () => {
    await h.bootSignedIn();
    expect(beats()).toHaveLength(1);
    expect(polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect([beats().length, polls().length]).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect([beats().length, polls().length]).toEqual([2, 3]);
  });

  it('R1 starts only once however often the profile is synced', async () => {
    await h.bootSignedIn();
    h.deps.fakeGoogle.deliverCredential('again');
    await h.flush();
    expect(beats()).toHaveLength(1);
  });

  it('R1 does not start a second poll while one is in flight', async () => {
    await h.bootSignedIn();
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('GET', '/api/users/online', () => new Promise<Response>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(polls()).toHaveLength(2);
    release(reply(200, []));
    await h.flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(polls()).toHaveLength(3);
  });

  it('R1 stop ignores late responses and cancels the timers', async () => {
    await h.bootSignedIn();
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('GET', '/api/users/online', () => new Promise<Response>((r) => (release = r)));
    await vi.advanceTimersByTimeAsync(15_000);
    h.app.actions.signOut();
    release(reply(200, [{ handle: 'ghost' }]));
    await h.flush();
    expect(h.state().presence).toMatchObject({ running: false, users: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(beats()).toHaveLength(1);
  });

  it('R2 a heartbeat 401 signs out', async () => {
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => reply(401, {}));
    await h.bootSignedIn();
    expect(h.state().auth.token).toBeNull();
  });

  it.each([404, 500])('R2 a heartbeat %i is ignored (and no first poll happens)', async (status) => {
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => reply(status, {}));
    await h.bootSignedIn();
    expect(h.state().auth.token).not.toBeNull();
    expect(h.state().presence.running).toBe(true);
    expect(polls()).toHaveLength(0);
  });

  it('R2 a network error on the heartbeat is retried on the next beat', async () => {
    let fail = true;
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => {
      if (fail) throw new Error('offline');
      return reply(200, { ban: null });
    });
    await h.bootSignedIn();
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(beats()).toHaveLength(2);
  });

  it('R2 a heartbeat without a body still polls', async () => {
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => new Response(null, { status: 204 }));
    await h.bootSignedIn();
    expect(polls()).toHaveLength(1);
  });

  it('R2 a ban in the heartbeat body sets me.ban and starts the countdown', async () => {
    const ban = { until: new Date(NOW.getTime() + 90_000).toISOString(), remainingSeconds: 90 };
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => reply(200, { ban }));
    await h.bootSignedIn();
    expect(h.state().auth.me?.ban).toEqual(ban);
    expect(h.state().ban?.label).toBe('1m 30s');
  });

  it('a poll 401 signs out, other failures keep the previous list', async () => {
    online([{ handle: 'alice' }, { handle: 'bob' }]);
    await h.bootSignedIn();
    h.deps.fakeFetch.on('GET', '/api/users/online', () => reply(500, {}));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view().count).toBe(2);
    h.deps.fakeFetch.on('GET', '/api/users/online', () => {
      throw new Error('offline');
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view().count).toBe(2);
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('GET', '/api/users/online', () => reply(401, {}));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.state().auth.token).toBeNull();
  });

  it('a non-array poll answer empties the list', async () => {
    online([{ handle: 'alice' }]);
    await h.bootSignedIn();
    h.deps.fakeFetch.on('GET', '/api/users/online', () => reply(200, { nope: true }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view().count).toBe(0);
  });
});

describe('user list (R3)', () => {
  it('counts everyone including you, and is empty when no one else is online', async () => {
    online([{ handle: 'alice' }]);
    await h.bootSignedIn();
    expect(view()).toMatchObject({ count: 1, empty: true });
    online([{ handle: 'alice' }, { handle: 'bob' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(view()).toMatchObject({ count: 2, empty: false });
  });

  it('counts down "banned · X" each second and offers Ban again on expiry (admin viewer)', async () => {
    online([
      { handle: 'alice', isAdmin: true },
      { handle: 'carol', bannedUntil: new Date(NOW.getTime() + 3000).toISOString() },
    ]);
    await h.bootSignedIn(meResponse({ isAdmin: true }));
    const carol = () => view().rows.find((r) => r.handle === 'carol');
    expect(carol()).toMatchObject({ bannedText: 'banned · 3s', canBan: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(carol()?.bannedText).toBe('banned · 2s');
    await vi.advanceTimersByTimeAsync(2000);
    expect(carol()).toMatchObject({ bannedText: null, canBan: true });
  });

  it('stops the 1s tick when nobody is banned', async () => {
    online([{ handle: 'alice' }, { handle: 'bob' }]);
    await h.bootSignedIn();
    const now = h.state().presence.now;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.state().presence.now).toBe(now);
  });
});

describe('banning a user (R4)', () => {
  const bans = () => h.deps.fakeFetch.requestsTo('POST', '/api/admin/users/ban');
  beforeEach(async () => {
    online([{ handle: 'alice', isAdmin: true }, { handle: 'bob' }]);
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(200, {}));
    await h.bootSignedIn(meResponse({ isAdmin: true }));
  });
  const ban = async () => {
    h.app.actions.banUser('bob');
    await h.flush();
  };

  it('asks for confirmation with the ladder text and does nothing when declined', async () => {
    h.deps.confirm.mockReturnValue(false);
    await ban();
    expect(h.deps.confirm).toHaveBeenCalledWith('Ban @bob? The ban length follows the ladder (1 min, 5 min, 30 min, …).');
    expect(bans()).toHaveLength(0);
  });

  it('POSTs {handle}, then re-polls the list on success', async () => {
    const before = polls().length;
    await ban();
    expect(JSON.parse(bans()[0]?.body ?? '')).toEqual({ handle: 'bob' });
    expect(polls().length).toBe(before + 1);
    expect(h.state().presence.banning).toEqual({});
  });

  it('disables the button while in flight and ignores a second click', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => new Promise<Response>((r) => (release = r)));
    h.app.actions.banUser('bob');
    await h.flush();
    expect(view().rows.find((r) => r.handle === 'bob')?.banDisabled).toBe(true);
    h.app.actions.banUser('bob');
    await h.flush();
    expect(bans()).toHaveLength(1);
    release(reply(200, {}));
    await h.flush();
    expect(view().rows.find((r) => r.handle === 'bob')?.banDisabled).toBe(false);
  });

  it('clears an earlier error when a new ban starts', async () => {
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(500, {}));
    await ban();
    expect(h.state().presence.error).not.toBe('');
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(200, {}));
    await ban();
    expect(h.state().presence.error).toBe('');
  });

  it('401 signs out', async () => {
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(401, {}));
    await ban();
    expect(h.state().auth.token).toBeNull();
  });

  it('403 shows "You are not allowed to ban users." and refreshes the profile', async () => {
    const meBefore = h.deps.fakeFetch.requestsTo('GET', '/api/me').length;
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(403, {}));
    await ban();
    expect(h.state().presence.error).toBe('You are not allowed to ban users.');
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/me').length).toBe(meBefore + 1);
  });

  it('404 shows "@bob no longer exists." and re-polls', async () => {
    const before = polls().length;
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(404, { error: 'UNKNOWN_HANDLE' }));
    await ban();
    expect(h.state().presence.error).toBe('@bob no longer exists.');
    expect(polls().length).toBe(before + 1);
  });

  it('409 CANNOT_BAN_ADMIN shows "Admins cannot be banned."', async () => {
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(409, { error: 'CANNOT_BAN_ADMIN' }));
    await ban();
    expect(h.state().presence.error).toBe('Admins cannot be banned.');
  });

  it('409 ALREADY_BANNED shows "@bob is already banned." and re-polls', async () => {
    const before = polls().length;
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(409, { error: 'ALREADY_BANNED' }));
    await ban();
    expect(h.state().presence.error).toBe('@bob is already banned.');
    expect(polls().length).toBe(before + 1);
  });

  it('other statuses show "Could not ban @bob (HTTP n)."', async () => {
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(500, {}));
    await ban();
    expect(h.state().presence.error).toBe('Could not ban @bob (HTTP 500).');
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => reply(409, {}));
    await ban();
    expect(h.state().presence.error).toBe('Could not ban @bob (HTTP 409).');
  });

  it('a network error shows "Network error. Try again."', async () => {
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => {
      throw new Error('offline');
    });
    await ban();
    expect(h.state().presence.error).toBe('Network error. Try again.');
    expect(h.state().presence.banning).toEqual({});
  });

  it('ignores the result when the session ended meanwhile', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('POST', '/api/admin/users/ban', () => new Promise<Response>((r) => (release = r)));
    h.app.actions.banUser('bob');
    await h.flush();
    h.app.actions.signOut();
    release(reply(500, {}));
    await h.flush();
    expect(h.state().presence.error).toBe('');
  });
});

describe('pageshow (R5)', () => {
  it('a page restored from the bfcache heartbeats again (and polls)', async () => {
    await h.bootSignedIn();
    h.app.actions.pageShow(true);
    await h.flush();
    expect(beats()).toHaveLength(2);
    expect(polls()).toHaveLength(2);
  });

  it('a normal pageshow does nothing', async () => {
    await h.bootSignedIn();
    h.app.actions.pageShow(false);
    await h.flush();
    expect(beats()).toHaveLength(1);
  });

  it('does nothing when presence is not running', async () => {
    await h.boot();
    h.app.actions.pageShow(true);
    await h.flush();
    expect(beats()).toHaveLength(0);
  });
});
