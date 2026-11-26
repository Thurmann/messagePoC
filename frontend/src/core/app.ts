import { createAdmin } from '../features/admin';
import { createBan } from '../features/ban';
import { createChatFeed } from '../features/chatFeed';
import { createConnection } from '../features/connection';
import { createGis } from '../features/gis';
import { createHandleDialog } from '../features/handleDialog';
import { createPresence } from '../features/presence';
import { createSender } from '../features/sender';
import { createSession } from '../features/session';
import type { ClientConfig } from '../api/types';
import type { Ctx } from './ctx';
import type { Deps } from './deps';
import { initialState, type AppConfig, type AppState } from './state';
import { createStore, type Store } from './store';

/** What the UI may do. Every action is safe to call at any time. */
export interface Actions {
  setDraft(text: string): void;
  submit(): void;
  signOut(): void;
  switchTab(tab: 'chat' | 'log'): void;
  banUser(handle: string): void;
  loadAudit(): void;
  openHandleDialog(): void;
  /** Cancel, Escape or the native dialog close event. */
  closeHandleDialog(): void;
  saveHandle(input: string): void;
  /** Wire to window 'pageshow' with event.persisted. */
  pageShow(persisted: boolean): void;
}

export interface App {
  store: Store<AppState>;
  actions: Actions;
  /**
   * Boots the app: config, public stream, Google sign-in, saved session. `gsiButton` is the element Google
   * renders its button into; by default #gsi-button is looked up, so call start() after the UI is rendered.
   * Resolves when the boot is complete.
   */
  start(gsiButton?: HTMLElement | null): Promise<void>;
}

function normalizeConfig(body: Partial<ClientConfig> | null): AppConfig {
  return {
    googleClientId: body?.googleClientId ?? '',
    messageApiBaseUrl: body?.messageApiBaseUrl ?? '',
    version: body?.version ?? '',
  };
}

export function createApp(deps: Deps): App {
  const store = createStore(initialState());
  // The services are created below and only reach each other at call time, so the cast is safe.
  const ctx = { deps, store } as Ctx;
  ctx.session = createSession(ctx);
  ctx.gis = createGis(ctx);
  ctx.connection = createConnection(ctx);
  ctx.chatFeed = createChatFeed(ctx);
  ctx.sender = createSender(ctx);
  ctx.ban = createBan(ctx);
  ctx.presence = createPresence(ctx);
  ctx.admin = createAdmin(ctx);
  ctx.handleDialog = createHandleDialog(ctx);

  async function loadConfig(): Promise<void> {
    try {
      const res = await deps.fetch('/api/config', { cache: 'no-store' });
      if (res.ok) {
        const config = normalizeConfig((await res.json()) as Partial<ClientConfig> | null);
        store.set((s) => ({ ...s, config }));
      }
    } catch {
      /* use defaults */
    }
  }

  async function start(gsiButton?: HTMLElement | null): Promise<void> {
    await loadConfig();
    ctx.connection.start();
    const saved = ctx.session.savedToken();
    const button = gsiButton === undefined ? document.getElementById('gsi-button') : gsiButton;
    await ctx.gis.init(button); // GIS must be ready before any 401 can trigger a silent renewal
    if (saved) await ctx.session.resume(saved);
    ctx.session.syncMe();
  }

  const actions: Actions = {
    setDraft: (text) => ctx.sender.setDraft(text),
    submit: () => ctx.sender.submit(),
    signOut: () => ctx.session.signOut(),
    switchTab: (tab) => ctx.admin.switchTab(tab),
    banUser: (handle) => void ctx.presence.banUser(handle),
    loadAudit: () => void ctx.admin.loadAudit(),
    openHandleDialog: () => ctx.handleDialog.open(),
    closeHandleDialog: () => ctx.handleDialog.close(),
    saveHandle: (input) => void ctx.handleDialog.save(input),
    pageShow: (persisted) => ctx.presence.pageShow(persisted),
  };

  return { store, actions, start };
}
