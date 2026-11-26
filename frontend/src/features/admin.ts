import type { AdminModerationRow, AuditLogEntry } from '../api/types';
import { patchSlice, sseContext, type Ctx } from '../core/ctx';
import { fmtDateTime, truncate } from '../lib/format';
import { startSse } from '../sse/stream';

export interface AdminService {
  /** Starts the admin stream once; resets the moderation list. */
  start(): void;
  stop(): void;
  switchTab(tab: 'chat' | 'log'): void;
  loadAudit(): Promise<void>;
}

const AUDIT_LIMIT = 30;

export function createAdmin(ctx: Ctx): AdminService {
  const { store } = ctx;
  let stopStream: (() => void) | null = null;
  const keys = new Set<string>();

  function addRow(raw: unknown): void {
    const row = raw as AdminModerationRow | null | undefined;
    if (!row || !row.messageId) return;
    const key = `${row.messageId}:${row.status}`;
    if (keys.has(key)) return;
    keys.add(key);
    const banThreshold = store.get().auth.me?.banThreshold ?? null;
    store.set((s) => ({
      ...s,
      admin: { ...s.admin, entries: [{ key, row, banThreshold }, ...s.admin.entries] },
    }));
  }

  async function loadModerationLog(): Promise<void> {
    try {
      const res = await ctx.session.authedFetch('/api/admin/moderation-log?limit=200', { cache: 'no-store' });
      if (res.status === 401) {
        ctx.session.signOut();
        return;
      }
      if (res.ok) {
        const rows = (await res.json()) as AdminModerationRow[];
        rows.slice().reverse().forEach(addRow);
      }
    } catch {
      /* ignore */
    }
  }

  function onForbidden(): void {
    // 403 is final: not an admin (anymore); stop retrying and hide the admin UI
    ctx.store.set((s) =>
      s.auth.me ? { ...s, auth: { ...s.auth, me: { ...s.auth.me, isAdmin: false } } } : s,
    );
    ctx.session.syncMe();
  }

  function start(): void {
    if (stopStream) return;
    keys.clear();
    patchSlice(ctx, 'admin', { entries: [] });
    stopStream = startSse(sseContext(ctx), '/api/admin/stream', {
      withAuth: true,
      onEvent: (name, row) => {
        if (name === 'moderation') addRow(row);
        else if (name === 'resync') void loadModerationLog();
      },
      afterConnect: () => void loadModerationLog(),
      onForbidden,
    });
  }

  function stop(): void {
    stopStream?.();
    stopStream = null;
  }

  function auditLine(a: AuditLogEntry): string {
    return `${fmtDateTime(a.timestamp)} · ${a.result || ''} · ${truncate(a.text || a.message, 80)}`;
  }

  async function loadAudit(): Promise<void> {
    patchSlice(ctx, 'admin', { audit: [] });
    try {
      const res = await ctx.session.authedFetch('/api/audit-logs', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as AuditLogEntry[];
      const lines = list.slice(0, AUDIT_LIMIT).map(auditLine);
      patchSlice(ctx, 'admin', { audit: lines.length ? lines : ['No audit entries.'] });
    } catch {
      patchSlice(ctx, 'admin', { audit: ['Could not load audit logs.'] });
    }
  }

  return { start, stop, switchTab: (tab) => patchSlice(ctx, 'admin', { tab }), loadAudit };
}
