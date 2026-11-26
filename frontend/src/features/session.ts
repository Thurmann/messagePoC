import { authedFetch, authHeaders } from '../api/client';
import type { MeResponse } from '../api/types';
import { authSource, patchSlice, type Ctx } from '../core/ctx';
import { renewalDelayMs } from '../lib/jwt';
import { safeGet, safeRemove, safeSet, TOKEN_KEY } from '../lib/storage';

export interface SessionService {
  authedFetch(path: string, init?: RequestInit): Promise<Response>;
  /** Asks Google for a fresh credential silently; resolves true when a new token arrived. */
  renewToken(): Promise<boolean>;
  onCredential(resp: { credential?: string } | null | undefined): Promise<void>;
  refreshMe(): Promise<void>;
  signOut(): void;
  /** Applies the side effects of the current auth/me state (legacy renderMe). */
  syncMe(): void;
  /** The token saved by a previous visit, if any. */
  savedToken(): string | null;
  /** Adopts a saved token and loads the profile. */
  resume(token: string): Promise<void>;
}

const RENEWAL_TIMEOUT_MS = 8000;

interface Renewal {
  promise: Promise<boolean>;
  finish(ok: boolean): void;
}

export function createSession(ctx: Ctx): SessionService {
  const { deps, store } = ctx;
  let tokenTimer: unknown = null;
  let renewal: Renewal | null = null;

  function scheduleRenewal(token: string | null): void {
    if (tokenTimer !== null) deps.clearTimeout(tokenTimer);
    tokenTimer = null;
    const wait = token ? renewalDelayMs(token, deps.now()) : null;
    if (wait === null) return;
    tokenTimer = deps.setTimeout(() => void renewToken(), wait);
  }

  function setToken(token: string | null): void {
    patchSlice(ctx, 'auth', { token: token || null });
    if (token) safeSet(deps.session, TOKEN_KEY, token);
    else safeRemove(deps.session, TOKEN_KEY);
    scheduleRenewal(token || null);
  }

  function startRenewal(): Renewal {
    let finish: (ok: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      let done = false;
      const timer = deps.setTimeout(() => finish(false), RENEWAL_TIMEOUT_MS);
      finish = (ok) => {
        if (done) return;
        done = true;
        deps.clearTimeout(timer);
        renewal = null;
        resolve(ok);
      };
    });
    return { promise, finish: (ok) => finish(ok) };
  }

  function renewToken(): Promise<boolean> {
    if (renewal) return renewal.promise;
    const id = deps.getGoogle()?.accounts?.id;
    if (!id) return Promise.resolve(false);
    const r = startRenewal();
    renewal = r;
    try {
      id.prompt((n) => {
        if (n && (n.isNotDisplayed?.() || n.isSkippedMoment?.())) r.finish(false);
      });
    } catch {
      r.finish(false);
    }
    return r.promise;
  }

  function fetchAuthed(path: string, init?: RequestInit): Promise<Response> {
    return authedFetch(deps.fetch, authSource(ctx), path, init);
  }

  function sendOffline(): void {
    try {
      deps
        .fetch('/api/me/presence', {
          method: 'DELETE',
          headers: authHeaders(store.get().auth.token),
          keepalive: true,
        })
        .catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  function signOut(): void {
    // a retry must never post with another user's token: stop every in-flight send of the signed-out user
    ctx.sender.stopAll();
    const s = store.get();
    if (s.auth.token && s.presence.running) sendOffline();
    ctx.presence.stop();
    setToken(null);
    patchSlice(ctx, 'auth', { me: null });
    deps.getGoogle()?.accounts?.id?.disableAutoSelect();
    ctx.admin.stop();
    syncMe();
  }

  async function onCredential(resp: { credential?: string } | null | undefined): Promise<void> {
    if (!resp || !resp.credential) return;
    setToken(resp.credential);
    renewal?.finish(true);
    if (!store.get().auth.me) await refreshMe();
  }

  async function loadMe(): Promise<MeResponse | null> {
    try {
      const res = await fetchAuthed('/api/me', { cache: 'no-store' });
      if (res.status === 401) {
        signOut();
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as MeResponse;
    } catch {
      setSendError('Could not load your profile. Try again shortly.');
      return null;
    }
  }

  function setSendError(sendError: string): void {
    store.set((s) => ({ ...s, sendError }));
  }

  async function refreshMe(): Promise<void> {
    if (!store.get().auth.token) return;
    const me = await loadMe();
    if (!me) return;
    patchSlice(ctx, 'auth', { me });
    syncMe();
    if (me.handle === null || me.handle === undefined) ctx.handleDialog.open();
  }

  function warnText(me: MeResponse): string | null {
    if (!me.warning || me.ban) return null;
    return (
      `You have ${me.strikes} flagged messages.` +
      (me.isAdmin ? '' : ` At ${me.banThreshold} your account is temporarily banned.`)
    );
  }

  function syncMe(): void {
    const { token, me } = store.get().auth;
    const signedMe = token && me ? me : null;
    store.set((s) => ({
      ...s,
      warnText: signedMe ? warnText(signedMe) : null,
      auth: { ...s.auth, gisReady: ctx.gis.isReady() },
    }));
    if (signedMe?.ban) ctx.ban.start(signedMe.ban.until, signedMe.ban.remainingSeconds);
    else ctx.ban.stop();
    if (signedMe?.isAdmin) ctx.admin.start();
    else {
      ctx.admin.stop();
      ctx.admin.switchTab('chat');
    }
    if (signedMe?.handle) ctx.presence.start();
    else ctx.presence.stop();
  }

  async function resume(token: string): Promise<void> {
    setToken(token);
    await refreshMe();
  }

  return {
    authedFetch: fetchAuthed,
    renewToken,
    onCredential,
    refreshMe,
    signOut,
    syncMe,
    savedToken: () => safeGet(deps.session, TOKEN_KEY),
    resume,
  };
}
