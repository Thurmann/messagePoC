import type { AuthSource } from '../api/client';
import { apiBase } from '../api/client';
import type { AdminService } from '../features/admin';
import type { BanService } from '../features/ban';
import type { ChatFeedService } from '../features/chatFeed';
import type { ConnectionService } from '../features/connection';
import type { GisService } from '../features/gis';
import type { HandleDialogService } from '../features/handleDialog';
import type { PresenceService } from '../features/presence';
import type { SenderService } from '../features/sender';
import type { SessionService } from '../features/session';
import type { SseContext } from '../sse/stream';
import type { Deps } from './deps';
import type { AppState } from './state';
import type { Store } from './store';

/** Shared by every feature service; services reach each other lazily (at call time) through it. */
export interface Ctx {
  deps: Deps;
  store: Store<AppState>;
  session: SessionService;
  gis: GisService;
  connection: ConnectionService;
  chatFeed: ChatFeedService;
  sender: SenderService;
  ban: BanService;
  presence: PresenceService;
  admin: AdminService;
  handleDialog: HandleDialogService;
}

/** Immutable update of one object slice of the state. */
export function patchSlice<K extends keyof AppState>(ctx: Ctx, key: K, patch: Partial<AppState[K]>): void {
  ctx.store.set((s) => ({ ...s, [key]: { ...(s[key] as object), ...patch } }));
}

export function patchMe(ctx: Ctx, patch: Partial<NonNullable<AppState['auth']['me']>>): void {
  ctx.store.set((s) => (s.auth.me ? { ...s, auth: { ...s.auth, me: { ...s.auth.me, ...patch } } } : s));
}

export function messageApiBase(ctx: Ctx): string {
  return apiBase(ctx.store.get().config.messageApiBaseUrl);
}

export function authSource(ctx: Ctx): AuthSource {
  return { getToken: () => ctx.store.get().auth.token, renewToken: () => ctx.session.renewToken() };
}

export function sseContext(ctx: Ctx): SseContext {
  return {
    fetch: ctx.deps.fetch,
    setTimeout: ctx.deps.setTimeout,
    getToken: () => ctx.store.get().auth.token,
    renewToken: () => ctx.session.renewToken(),
    signOut: () => ctx.session.signOut(),
  };
}
