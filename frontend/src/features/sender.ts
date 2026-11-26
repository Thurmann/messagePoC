import type { ApiErrorBody } from '../api/types';
import { messageApiBase, type Ctx } from '../core/ctx';
import { composerView } from '../core/selectors';
import { MAX_ATTEMPTS, retryDelayMs } from '../lib/retry';

export interface SenderService {
  /** Sends the composer text (trimmed); no-op when empty or the composer is disabled. */
  submit(): void;
  setDraft(text: string): void;
  /** Resolves a pending send by a stream/history result. Returns false when the id is not pending. */
  resolvePending(messageId: string): boolean;
  /** Sign-out: stops every in-flight send and marks it unconfirmed. Entries stay so a late result still resolves them. */
  stopAll(): void;
}

interface Pending {
  text: string;
  messageId: string;
  attempts: number;
  timer: unknown;
  stopped: boolean;
}

export const NOT_CONFIRMED = 'not confirmed – it may still appear';
const RETRYING = 'not confirmed yet – retrying…';
const CHECKING = 'checking…';
const NETWORK_RETRY_MS = 5000;

export function createSender(ctx: Ctx): SenderService {
  const { deps, store } = ctx;
  const pending = new Map<string, Pending>();
  let lastFailed: { text: string; messageId: string } | null = null;

  const isCurrent = (p: Pending): boolean => !p.stopped && pending.get(p.messageId) === p;
  const patchLine = (p: Pending, patch: Parameters<typeof ctx.chatFeed.patchLine>[1]): void =>
    ctx.chatFeed.patchLine(p.messageId, patch);

  function clearTimer(p: Pending): void {
    if (p.timer !== null) deps.clearTimeout(p.timer);
    p.timer = null;
  }

  function setSendError(sendError: string): void {
    store.set((s) => ({ ...s, sendError }));
  }

  // Outcome unknown (Kafka did not confirm / network error): keep the line and resend with the SAME messageId.
  function unconfirmed(p: Pending, delayMs: number): void {
    if (p.attempts >= MAX_ATTEMPTS) {
      // stays pending: a late result still resolves the line
      patchLine(p, { pending: false, unconfirmed: true, status: NOT_CONFIRMED });
      return;
    }
    patchLine(p, { pending: false, unconfirmed: true, status: RETRYING });
    p.timer = deps.setTimeout(() => {
      p.timer = null;
      void attempt(p);
    }, delayMs);
  }

  // Definite failure: nothing was accepted, so drop the line and give the text back.
  function failMessage(p: Pending, message: string, status: number, err: ApiErrorBody): void {
    pending.delete(p.messageId);
    clearTimer(p);
    ctx.chatFeed.removeLine(p.messageId);
    lastFailed = { text: p.text, messageId: p.messageId };
    if (!store.get().draft || p.attempts <= 1) store.set((s) => ({ ...s, draft: p.text }));
    if (status === 401) {
      ctx.session.signOut();
      setSendError('Your session expired. Please sign in again.');
    } else if (status === 403 && err.error === 'BANNED') {
      ctx.ban.start(err.bannedUntil, err.remainingSeconds);
    } else if (status === 409 && err.error === 'HANDLE_REQUIRED') {
      ctx.handleDialog.open();
    } else setSendError(message);
  }

  async function readError(res: Response): Promise<ApiErrorBody> {
    try {
      return ((await res.json()) as ApiErrorBody | null) ?? {};
    } catch {
      return {};
    }
  }

  async function post(p: Pending): Promise<Response | null> {
    try {
      return await ctx.session.authedFetch(`${messageApiBase(ctx)}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: p.text, messageId: p.messageId }),
      });
    } catch {
      return null;
    }
  }

  async function attempt(p: Pending): Promise<void> {
    if (!isCurrent(p)) return; // stopped, or already resolved by the stream
    if (!store.get().auth.token) {
      patchLine(p, { status: NOT_CONFIRMED });
      return;
    }
    p.attempts++;
    const res = await post(p);
    if (!isCurrent(p)) return; // result arrived meanwhile
    if (!res) {
      unconfirmed(p, NETWORK_RETRY_MS);
      return;
    }
    if (res.status === 202) {
      lastFailed = null;
      patchLine(p, { unconfirmed: false, status: CHECKING }); // the stream (or history) resolves it
      return;
    }
    const err = await readError(res);
    if (!isCurrent(p)) return;
    if (res.status === 503 && err.status === 'UNCONFIRMED') unconfirmed(p, retryDelayMs(res));
    else if (res.status === 503 && err.error === 'UNAVAILABLE') {
      failMessage(p, 'Service temporarily unavailable. Please try again.', 503, err);
    } else if (res.status >= 500) unconfirmed(p, retryDelayMs(res)); // may have reached Kafka
    else failMessage(p, `Could not send message (HTTP ${res.status}).`, res.status, err);
  }

  function sendMessage(text: string, reuseId: string | null): void {
    setSendError('');
    // never overwrite a pending entry
    const messageId = !reuseId || pending.has(reuseId) || ctx.chatFeed.knows(reuseId) ? deps.randomUUID() : reuseId;
    ctx.chatFeed.addLine({
      key: messageId,
      kind: 'user',
      handle: store.get().auth.me?.handle ?? undefined,
      text,
      time: new Date(deps.now()).toISOString(),
      pending: true,
      unconfirmed: false,
      failed: false,
      status: CHECKING,
    });
    const p: Pending = { text, messageId, attempts: 0, timer: null, stopped: false };
    // register before the POST so a stream result that beats the response still resolves the line
    pending.set(messageId, p);
    void attempt(p);
  }

  function submit(): void {
    const state = store.get();
    const text = state.draft.trim();
    if (!text || composerView(state).disabled) return;
    const reuseId = lastFailed && lastFailed.text === text ? lastFailed.messageId : null;
    lastFailed = null;
    store.set((s) => ({ ...s, draft: '' }));
    sendMessage(text, reuseId);
  }

  function resolvePending(messageId: string): boolean {
    const p = pending.get(messageId);
    if (!p) return false;
    pending.delete(messageId);
    clearTimer(p);
    return true;
  }

  function stopAll(): void {
    pending.forEach((p) => {
      p.stopped = true;
      clearTimer(p);
      patchLine(p, { pending: false, unconfirmed: true, status: NOT_CONFIRMED });
    });
    lastFailed = null;
  }

  return {
    submit,
    setDraft: (draft) => store.set((s) => ({ ...s, draft })),
    resolvePending,
    stopAll,
  };
}
