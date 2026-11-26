import type { ChatLine } from '../core/state';
import type { Ctx } from '../core/ctx';

export interface ChatFeedService {
  /** A public stream/history event; ignored without a messageId or when already seen. */
  handleChatEvent(type: string, ev: unknown): void;
  addLine(line: ChatLine): void;
  patchLine(key: string, patch: Partial<ChatLine>): void;
  removeLine(key: string): void;
  /** True when the id is a current line key or was already seen on the stream/history. */
  knows(messageId: string): boolean;
}

interface RawChatEvent {
  messageId?: string;
  handle?: string;
  text?: string;
  occurredAt?: string;
}

export const FLAGGED_STATUS = 'not posted · flagged by moderation';

export function createChatFeed(ctx: Ctx): ChatFeedService {
  const { store } = ctx;
  const seen = new Set<string>();

  function addLine(line: ChatLine): void {
    store.set((s) => ({ ...s, lines: [...s.lines, line] }));
  }

  function patchLine(key: string, patch: Partial<ChatLine>): void {
    store.set((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  }

  function removeLine(key: string): void {
    store.set((s) => ({ ...s, lines: s.lines.filter((l) => l.key !== key) }));
  }

  function resolvePendingLine(id: string, type: string): void {
    seen.add(id);
    if (type === 'message') {
      patchLine(id, { pending: false, unconfirmed: false, status: null });
    } else {
      patchLine(id, { pending: false, unconfirmed: false, failed: true, status: FLAGGED_STATUS });
      void ctx.session.refreshMe();
    }
  }

  function newLine(type: string, id: string, ev: RawChatEvent): ChatLine {
    const base = { key: id, pending: false, unconfirmed: false, failed: false, status: null };
    if (type === 'message') {
      return { ...base, kind: 'user', handle: ev.handle, text: ev.text ?? '', time: ev.occurredAt };
    }
    return { ...base, kind: 'sys', text: `A message from ${ev.handle} was removed by moderation.` };
  }

  function handleChatEvent(type: string, raw: unknown): void {
    const ev = raw as RawChatEvent | null | undefined;
    if (!ev || !ev.messageId) return;
    const id = ev.messageId;
    if (ctx.sender.resolvePending(id)) {
      resolvePendingLine(id, type);
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    addLine(newLine(type, id, ev));
  }

  function knows(messageId: string): boolean {
    return seen.has(messageId) || store.get().lines.some((l) => l.key === messageId);
  }

  return { handleChatEvent, addLine, patchLine, removeLine, knows };
}
