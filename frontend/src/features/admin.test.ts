import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminModerationRow, AuditLogEntry } from '../api/types';
import { cardView, layoutView, logRowView } from '../core/selectors';
import { reply } from '../test/fakes';
import { createHarness, emit, meResponse, type Harness } from '../test/harness';

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-03-01T12:00:00Z'));
  h = createHarness();
});
afterEach(() => {
  vi.useRealTimers();
});

const row = (id: string, patch: Partial<AdminModerationRow> = {}): AdminModerationRow => ({
  occurredAt: '2025-03-01T10:00:00Z',
  messageId: id,
  email: `${id}@example.com`,
  handle: 'bob',
  status: 'REJECTED',
  score: 0.9,
  text: `text ${id}`,
  reason: 'profanity',
  strikesAfter: 1,
  currentStrikes: 1,
  banState: null,
  ...patch,
});
const admin = () => h.state().admin;
const keys = () => admin().entries.map((e) => e.key);
const adminStream = () => h.adminStreams[0];
const adminMe = (patch = {}) => meResponse({ isAdmin: true, ...patch });

describe('stream and log (A1)', () => {
  it('opens the admin stream with auth and loads the log (limit 200) after connecting, keeping server order', async () => {
    h.deps.fakeFetch.on('GET', '/api/admin/moderation-log', () => reply(200, [row('n3'), row('n2'), row('n1')]));
    await h.bootSignedIn(adminMe());
    const req = h.deps.fakeFetch.requestsTo('GET', '/api/admin/stream')[0];
    expect(req?.headers.Authorization).toMatch(/^Bearer /);
    expect(req?.headers.Accept).toBe('text/event-stream');
    expect(h.deps.fakeFetch.fetch).toHaveBeenCalledWith(
      '/api/admin/moderation-log?limit=200',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(keys()).toEqual(['n3:REJECTED', 'n2:REJECTED', 'n1:REJECTED']);
  });

  it('prepends a moderation event and dedupes by messageId:status', async () => {
    await h.bootSignedIn(adminMe());
    await emit(adminStream(), 'moderation', row('a'));
    await emit(adminStream(), 'moderation', row('b'));
    await emit(adminStream(), 'moderation', row('a'));
    await emit(adminStream(), 'moderation', row('a', { status: 'DLT' }));
    expect(keys()).toEqual(['a:DLT', 'b:REJECTED', 'a:REJECTED']);
  });

  it('ignores rows without messageId', async () => {
    await h.bootSignedIn(adminMe());
    await emit(adminStream(), 'moderation', { status: 'REJECTED' });
    await emit(adminStream(), 'moderation', null);
    expect(admin().entries).toEqual([]);
  });

  it('resync reloads the log without duplicating rows', async () => {
    h.deps.fakeFetch.on('GET', '/api/admin/moderation-log', () => reply(200, [row('a')]));
    await h.bootSignedIn(adminMe());
    await emit(adminStream(), 'resync', {});
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/admin/moderation-log')).toHaveLength(2);
    expect(keys()).toEqual(['a:REJECTED']);
  });

  it('a 401 on the log signs out', async () => {
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('GET', '/api/admin/moderation-log', () => reply(401, {}));
    await h.bootSignedIn(adminMe());
    expect(h.state().auth.token).toBeNull();
  });

  it('other log failures are ignored', async () => {
    h.deps.fakeFetch.on('GET', '/api/admin/moderation-log', () => reply(500, {}));
    await h.bootSignedIn(adminMe());
    expect(admin().entries).toEqual([]);
    expect(h.state().auth.token).not.toBeNull();
  });

  it('a second sync does not open a second stream; signing out and in again resets the list', async () => {
    await h.bootSignedIn(adminMe());
    await emit(adminStream(), 'moderation', row('a'));
    h.deps.fakeGoogle.deliverCredential('again');
    await h.flush();
    expect(h.adminStreams).toHaveLength(1);
    h.app.actions.signOut();
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/admin/stream')[0]?.signal?.aborted).toBe(true);
    h.deps.fakeGoogle.deliverCredential('third');
    await h.flush();
    expect(h.adminStreams).toHaveLength(2);
    expect(admin().entries).toEqual([]);
    await emit(h.adminStreams[1], 'moderation', row('a'));
    expect(keys()).toEqual(['a:REJECTED']);
  });
});

describe('admin stream errors (A2)', () => {
  it('403 stops for good, drops isAdmin and hides the admin UI', async () => {
    h.deps.fakeFetch.on('GET', '/api/admin/stream', () => reply(403, {}));
    await h.bootSignedIn(adminMe());
    expect(h.state().auth.me?.isAdmin).toBe(false);
    expect(layoutView(h.state())).toMatchObject({ showTabs: false, showRail: false, noRail: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/admin/stream')).toHaveLength(1);
    expect(h.state().auth.token).not.toBeNull();
  });

  it('403 while on the log tab switches back to chat', async () => {
    h.deps.fakeFetch.on('GET', '/api/admin/stream', () => reply(403, {}));
    h.withSavedSession(adminMe());
    h.app.actions.switchTab('log');
    await h.boot();
    expect(admin().tab).toBe('chat');
  });

  it('401 with no renewal available signs out', async () => {
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('GET', '/api/admin/stream', () => reply(401, {}));
    await h.bootSignedIn(adminMe());
    expect(h.state().auth.token).toBeNull();
  });
});

describe('cards and table (A3, A4)', () => {
  it('captures the ban threshold known when the row arrived', async () => {
    await h.bootSignedIn(adminMe({ banThreshold: 5 }));
    await emit(adminStream(), 'moderation', row('a', { strikesAfter: 2 }));
    expect(cardView(admin().entries[0]!).meta).toEqual(['score 0.90 · strike 2 / 5']);
    expect(logRowView(admin().entries[0]!)).toMatchObject({ strikes: '2 (now 1)', score: '0.90' });
  });
});

describe('tabs (A5)', () => {
  it('toggles between chat and log views', async () => {
    await h.bootSignedIn(adminMe());
    h.app.actions.switchTab('log');
    expect(layoutView(h.state())).toMatchObject({ showChat: false, showLog: true });
    h.app.actions.switchTab('chat');
    expect(layoutView(h.state())).toMatchObject({ showChat: true, showLog: false });
  });

  it('a non-admin session is forced back to the chat tab', async () => {
    h.app.actions.switchTab('log');
    await h.bootSignedIn(meResponse());
    expect(admin().tab).toBe('chat');
  });
});

describe('audit logs (A6)', () => {
  const audit = (i: number, patch: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
    timestamp: '2025-03-01T10:00:00Z',
    message: `message ${i}`,
    result: 'REJECTED',
    text: `text ${i}`,
    messageId: null,
    correlationId: null,
    profanityScore: null,
    ...patch,
  });
  const load = async () => {
    h.app.actions.loadAudit();
    await h.flush();
  };
  beforeEach(async () => {
    await h.bootSignedIn(adminMe());
  });

  it('lists at most 30 entries as "<datetime> · <result> · <text>"', async () => {
    h.deps.fakeFetch.on('GET', '/api/audit-logs', () => reply(200, Array.from({ length: 40 }, (_, i) => audit(i))));
    await load();
    expect(admin().audit).toHaveLength(30);
    expect(admin().audit?.[0]).toMatch(/ · REJECTED · text 0$/);
  });

  it('falls back to the message, an empty result and truncates at 80', async () => {
    h.deps.fakeFetch.on('GET', '/api/audit-logs', () =>
      reply(200, [audit(1, { text: null, result: null, message: 'm'.repeat(90) })]),
    );
    await load();
    expect(admin().audit?.[0]).toMatch(new RegExp(` ·  · ${'m'.repeat(80)}…$`));
  });

  it('shows "No audit entries." for an empty list', async () => {
    h.deps.fakeFetch.on('GET', '/api/audit-logs', () => reply(200, []));
    await load();
    expect(admin().audit).toEqual(['No audit entries.']);
  });

  it.each([
    ['a non-OK answer', () => reply(500, {})],
    [
      'a network error',
      () => {
        throw new Error('offline');
      },
    ],
  ])('shows "Could not load audit logs." on %s', async (_n, respond) => {
    h.deps.fakeFetch.on('GET', '/api/audit-logs', respond);
    await load();
    expect(admin().audit).toEqual(['Could not load audit logs.']);
  });

  it('a 401 shows the error and does not sign out', async () => {
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('GET', '/api/audit-logs', () => reply(401, {}));
    await load();
    expect(admin().audit).toEqual(['Could not load audit logs.']);
    expect(h.state().auth.token).not.toBeNull();
  });

  it('clears the previous result while loading', async () => {
    h.deps.fakeFetch.on('GET', '/api/audit-logs', () => reply(200, [audit(1)]));
    await load();
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('GET', '/api/audit-logs', () => new Promise<Response>((r) => (release = r)));
    h.app.actions.loadAudit();
    await h.flush();
    expect(admin().audit).toEqual([]);
    release(reply(200, []));
    await h.flush();
  });
});
