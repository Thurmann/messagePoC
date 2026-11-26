import { patchSlice, type Ctx } from '../core/ctx';
import type { AppState } from '../core/state';
import { HANDLE_RE } from '../lib/handle';

export interface HandleDialogService {
  open(): void;
  /** Cancel, Escape or the native close event. */
  close(): void;
  /** Save the handle typed in the (uncontrolled) input. */
  save(input: string): Promise<void>;
}

const FORMAT_HINT = 'Use 3-20 letters, digits or underscores.';

export function createHandleDialog(ctx: Ctx): HandleDialogService {
  const set = (patch: Partial<AppState['dialog']>): void => patchSlice(ctx, 'dialog', patch);

  function open(): void {
    ctx.store.set((s) => ({ ...s, dialog: { ...s.dialog, open: true, error: '', openSeq: s.dialog.openSeq + 1 } }));
  }

  function close(): void {
    set({ open: false });
  }

  async function put(handle: string): Promise<Response> {
    return ctx.session.authedFetch('/api/me/handle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
  }

  async function applyResult(res: Response): Promise<void> {
    if (res.ok) {
      close();
      await ctx.session.refreshMe();
    } else if (res.status === 401) {
      close();
      ctx.session.signOut();
    } else if (res.status === 400) set({ error: `Invalid handle. ${FORMAT_HINT}` });
    else if (res.status === 409) set({ error: 'That handle is taken (or you already have one).' });
    else set({ error: `Could not save handle (HTTP ${res.status}).` });
  }

  async function save(input: string): Promise<void> {
    const handle = input.trim();
    if (!HANDLE_RE.test(handle)) {
      set({ error: FORMAT_HINT });
      return;
    }
    set({ saving: true });
    try {
      await applyResult(await put(handle));
    } catch {
      set({ error: 'Network error. Try again.' });
    } finally {
      set({ saving: false });
    }
  }

  return { open, close, save };
}
