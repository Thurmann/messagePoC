import type { ApiErrorBody, OnlineUser, PresenceResponse } from '../api/types';
import { patchMe, patchSlice, type Ctx } from '../core/ctx';

export interface PresenceService {
  start(): void;
  stop(): void;
  /** Ban a user (admin only) after a confirmation. */
  banUser(handle: string): Promise<void>;
  /** Browser pageshow: a page restored from the back/forward cache heartbeats again. */
  pageShow(persisted: boolean): void;
}

const HEARTBEAT_MS = 30000;
const POLL_MS = 15000;
const TICK_MS = 1000;

/** Seconds a user stays banned from `now`, 0 when not banned. */
export function bannedLeftSeconds(user: OnlineUser, now: number): number {
  const until = user.bannedUntil ? Date.parse(user.bannedUntil) : NaN;
  return Number.isNaN(until) ? 0 : (until - now) / 1000;
}

export function createPresence(ctx: Ctx): PresenceService {
  const { deps, store } = ctx;
  let gen = 0;
  let polling = 0;
  let hbTimer: unknown = null;
  let pollTimer: unknown = null;
  let tickTimer: unknown = null;
  /** End times (epoch ms) of the users shown as banned at the last render. */
  let bannedEnds: number[] = [];

  const setError = (error: string): void => patchSlice(ctx, 'presence', { error });

  function clearTick(): void {
    if (tickTimer !== null) deps.clearInterval(tickTimer);
    tickTimer = null;
  }

  /** Re-renders the list at the current time and keeps the 1s countdown running only while someone is banned. */
  function render(): void {
    const now = deps.now();
    patchSlice(ctx, 'presence', { now });
    clearTick();
    bannedEnds = store
      .get()
      .presence.users.filter((u) => u && u.handle && bannedLeftSeconds(u, now) > 0)
      .map((u) => Date.parse(u.bannedUntil as string));
    if (bannedEnds.length) tickTimer = deps.setInterval(tick, TICK_MS);
  }

  function tick(): void {
    const now = deps.now();
    if (bannedEnds.some((end) => (end - now) / 1000 <= 0)) render();
    else patchSlice(ctx, 'presence', { now });
  }

  function start(): void {
    if (store.get().presence.running) return;
    patchSlice(ctx, 'presence', { running: true });
    const g = ++gen;
    void heartbeat(g, true);
    hbTimer = deps.setInterval(() => void heartbeat(g, false), HEARTBEAT_MS);
    pollTimer = deps.setInterval(() => void pollUsers(g), POLL_MS);
  }

  function stop(): void {
    if (hbTimer !== null) deps.clearInterval(hbTimer);
    if (pollTimer !== null) deps.clearInterval(pollTimer);
    clearTick();
    hbTimer = pollTimer = null;
    gen++; // invalidates in-flight responses
    bannedEnds = [];
    patchSlice(ctx, 'presence', { running: false, users: [], banning: {}, error: '' });
  }

  async function readPresence(res: Response): Promise<PresenceResponse | null> {
    try {
      return (await res.json()) as PresenceResponse | null;
    } catch {
      return null; // no body
    }
  }

  async function heartbeat(g: number, first: boolean): Promise<void> {
    try {
      const res = await ctx.session.authedFetch('/api/me/presence', { method: 'POST', cache: 'no-store' });
      if (g !== gen) return;
      if (res.status === 401) {
        ctx.session.signOut();
        return;
      }
      if (!res.ok) return;
      const body = await readPresence(res);
      if (g !== gen) return;
      if (body?.ban) {
        patchMe(ctx, { ban: body.ban });
        ctx.ban.start(body.ban.until, body.ban.remainingSeconds);
      }
      if (first) void pollUsers(g);
    } catch {
      /* retry on the next beat */
    }
  }

  async function pollUsers(g: number): Promise<void> {
    if (g !== gen || polling === g) return;
    polling = g;
    try {
      const res = await ctx.session.authedFetch('/api/users/online', { cache: 'no-store' });
      if (g !== gen) return;
      if (res.status === 401) {
        ctx.session.signOut();
        return;
      }
      if (!res.ok) return;
      const list = (await res.json()) as unknown;
      if (g !== gen) return;
      patchSlice(ctx, 'presence', { users: Array.isArray(list) ? (list as OnlineUser[]) : [] });
      render();
    } catch {
      /* keep the previous list */
    } finally {
      if (polling === g) polling = 0;
    }
  }

  async function readError(res: Response): Promise<ApiErrorBody> {
    try {
      return ((await res.json()) as ApiErrorBody | null) ?? {};
    } catch {
      return {};
    }
  }

  function setBanning(handle: string, on: boolean): void {
    store.set((s) => {
      const banning = { ...s.presence.banning };
      if (on) banning[handle] = true;
      else delete banning[handle];
      return { ...s, presence: { ...s.presence, banning } };
    });
  }

  async function postBan(handle: string): Promise<Response> {
    return ctx.session.authedFetch('/api/admin/users/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
  }

  async function applyBanResult(res: Response, handle: string, g: number): Promise<void> {
    if (res.status === 401) {
      ctx.session.signOut();
      return;
    }
    const err = res.ok ? {} : await readError(res);
    if (g !== gen) return;
    if (res.ok) void pollUsers(g);
    else if (res.status === 403) {
      setError('You are not allowed to ban users.');
      void ctx.session.refreshMe();
    } else if (res.status === 404) {
      setError(`@${handle} no longer exists.`);
      void pollUsers(g);
    } else if (res.status === 409 && err.error === 'CANNOT_BAN_ADMIN') setError('Admins cannot be banned.');
    else if (res.status === 409 && err.error === 'ALREADY_BANNED') {
      setError(`@${handle} is already banned.`);
      void pollUsers(g);
    } else setError(`Could not ban @${handle} (HTTP ${res.status}).`);
  }

  async function banUser(handle: string): Promise<void> {
    if (store.get().presence.banning[handle]) return;
    if (!deps.confirm(`Ban @${handle}? The ban length follows the ladder (1 min, 5 min, 30 min, …).`)) return;
    const g = gen;
    setBanning(handle, true);
    render();
    setError('');
    try {
      const res = await postBan(handle);
      if (g !== gen) return;
      await applyBanResult(res, handle, g);
    } catch {
      if (g === gen) setError('Network error. Try again.');
    } finally {
      setBanning(handle, false);
      if (g === gen) render();
    }
  }

  function pageShow(persisted: boolean): void {
    if (persisted && store.get().auth.token && store.get().presence.running) void heartbeat(gen, true);
  }

  return { start, stop, banUser, pageShow };
}
