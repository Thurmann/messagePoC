import { patchSlice, type Ctx } from '../core/ctx';

export interface GisService {
  /** Loads Google sign-in and renders its button into `button`. Failures become a setup notice. */
  init(button: HTMLElement | null): Promise<void>;
  isReady(): boolean;
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';

export function createGis(ctx: Ctx): GisService {
  let ready = false;

  function notice(text: string): void {
    patchSlice(ctx, 'auth', { setupNotice: text });
  }

  async function init(button: HTMLElement | null): Promise<void> {
    const clientId = ctx.store.get().config.googleClientId;
    if (!clientId) {
      notice('Set GOOGLE_CLIENT_ID to enable sign-in');
      return;
    }
    try {
      await ctx.deps.loadScript(GSI_SRC);
      const id = ctx.deps.getGoogle()?.accounts?.id;
      if (!id || !button) throw new Error('Google sign-in unavailable');
      id.initialize({
        client_id: clientId,
        callback: (resp) => void ctx.session.onCredential(resp),
        auto_select: true,
      });
      id.renderButton(button, { theme: 'outline', size: 'medium', type: 'standard' });
      ready = true;
    } catch {
      notice('Could not load Google sign-in.');
    }
  }

  return { init, isReady: () => ready };
}
