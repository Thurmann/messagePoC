import { describe, expect, it } from 'vitest';
import type { AdminModerationRow, OnlineUser } from '../api/types';
import { meResponse } from '../test/harness';
import {
  banBannerText,
  cardView,
  composerView,
  connView,
  layoutView,
  lineView,
  logRowView,
  sessionView,
  userRows,
  usersView,
  versionView,
} from './selectors';
import { initialState, type AppState, type ChatLine, type ModerationEntry } from './state';

function stateWith(patch: (s: AppState) => Partial<AppState>): AppState {
  const s = initialState();
  return { ...s, ...patch(s) };
}
const signedIn = (me = meResponse()) => stateWith((s) => ({ auth: { ...s.auth, token: 't', me } }));

describe('connView (C4, B1)', () => {
  it('is "offline" without class before the first stream result', () => {
    expect(connView(initialState())).toEqual({ text: 'offline', title: 'Stream connection', className: '' });
  });
  it('shows reconnecting when the stream is down', () => {
    const s = stateWith((x) => ({ conn: { ...x.conn, sse: false } }));
    expect(connView(s)).toEqual({
      text: 'reconnecting…',
      title: 'Connection to the chat stream lost; reconnecting.',
      className: '',
    });
  });
  it('shows live with class on', () => {
    const s = stateWith((x) => ({ conn: { ...x.conn, sse: true } }));
    expect(connView(s)).toEqual({ text: 'live', title: 'Connected to the live chat stream.', className: 'on' });
  });
  it('warns when Kafka is down but the stream is up', () => {
    const s = stateWith(() => ({ conn: { sse: true, kafka: 'DOWN' } }));
    expect(connView(s)).toEqual({
      text: 'live · Kafka unavailable, messages delayed',
      title:
        'Live updates work, but the message broker is unavailable. Messages you send are retried until confirmed.',
      className: 'warn',
    });
  });
  it('does not warn about Kafka while the stream itself is down', () => {
    const s = stateWith(() => ({ conn: { sse: false, kafka: 'DOWN' } }));
    expect(connView(s).text).toBe('reconnecting…');
  });
});

describe('versionView (B2)', () => {
  it('hides without a version', () => {
    expect(versionView(initialState())).toEqual({ visible: false, text: '', title: '' });
  });
  it('shows v<version>', () => {
    const s = stateWith((x) => ({ config: { ...x.config, version: '1.2.3' } }));
    expect(versionView(s)).toEqual({ visible: true, text: 'v1.2.3', title: 'Running version 1.2.3' });
  });
});

describe('sessionView (M1, G4)', () => {
  it('shows the login only when signed out and Google is ready', () => {
    const ready = stateWith((s) => ({ auth: { ...s.auth, gisReady: true } }));
    expect(sessionView(ready).showLogin).toBe(true);
    expect(sessionView(initialState()).showLogin).toBe(false);
    expect(sessionView(signedIn()).showLogin).toBe(false);
  });
  it('labels with @handle, or the email without a handle', () => {
    expect(sessionView(signedIn()).meLabel).toBe('@alice');
    expect(sessionView(signedIn(meResponse({ handle: null }))).meLabel).toBe('alice@example.com');
  });
  it('is not signed in with a token but no profile', () => {
    const s = stateWith((x) => ({ auth: { ...x.auth, token: 't' } }));
    expect(sessionView(s).signed).toBe(false);
  });
});

describe('layoutView (M4, M5, A5 and the allowed deviation)', () => {
  it('starts with no users, no rail, no tabs and the chat view', () => {
    expect(layoutView(initialState())).toEqual({
      showTabs: false,
      showRail: false,
      showUsers: false,
      noRail: true,
      noUsers: true,
      showChat: true,
      showLog: false,
    });
  });
  it('shows tabs and rail for a signed-in admin', () => {
    const v = layoutView(signedIn(meResponse({ isAdmin: true })));
    expect(v).toMatchObject({ showTabs: true, showRail: true, noRail: false });
  });
  it('follows presence.running for the users panel and admin.tab for the views', () => {
    const s = stateWith((x) => ({
      presence: { ...x.presence, running: true },
      admin: { ...x.admin, tab: 'log' },
    }));
    expect(layoutView(s)).toMatchObject({ showUsers: true, noUsers: false, showChat: false, showLog: true });
  });
});

describe('composerView (P1)', () => {
  it('asks to sign in when signed out', () => {
    expect(composerView(initialState())).toEqual({ disabled: true, placeholder: 'Sign in to chat' });
  });
  it('asks for a handle', () => {
    expect(composerView(signedIn(meResponse({ handle: null })))).toEqual({
      disabled: true,
      placeholder: 'Choose a handle to chat',
    });
  });
  it('is disabled while banned', () => {
    const s = { ...signedIn(), ban: { until: 1, label: '5s' } };
    expect(composerView(s)).toEqual({ disabled: true, placeholder: 'You are temporarily banned' });
  });
  it('mentions Kafka when it is down', () => {
    const s = { ...signedIn(), conn: { sse: true, kafka: 'DOWN' as const } };
    expect(composerView(s)).toEqual({
      disabled: false,
      placeholder: 'Write a message (Kafka unavailable, messages may be delayed)',
    });
  });
  it('is enabled with the plain placeholder otherwise', () => {
    expect(composerView(signedIn())).toEqual({ disabled: false, placeholder: 'Write a message' });
  });
});

describe('banBannerText (N2)', () => {
  it('is null without a ban, else the countdown sentence', () => {
    expect(banBannerText(initialState())).toBeNull();
    const s = stateWith(() => ({ ban: { until: 1, label: '1m 5s' } }));
    expect(banBannerText(s)).toBe('You are temporarily banned from posting. Time remaining: 1m 5s');
  });
});

describe('lineView (F4, F5, F2, F3)', () => {
  const base: ChatLine = {
    key: 'k',
    kind: 'user',
    handle: 'bob',
    text: 'hi',
    pending: false,
    unconfirmed: false,
    failed: false,
    status: null,
  };
  it('builds classes from flags', () => {
    expect(lineView(base).className).toBe('line');
    expect(lineView({ ...base, kind: 'sys' }).className).toBe('line sys');
    expect(lineView({ ...base, pending: true, status: 'checking…' })).toMatchObject({
      className: 'line pending',
      status: 'checking…',
    });
    expect(lineView({ ...base, unconfirmed: true }).className).toBe('line unconfirmed');
    expect(lineView({ ...base, failed: true }).className).toBe('line failed');
  });
  it('formats the time and picks the handle colour', () => {
    const v = lineView({ ...base, time: '2025-01-01T10:11:12Z' });
    expect(v.time).toMatch(/\d{2}.\d{2}.\d{2}/);
    expect(v.colorClass).toMatch(/^c[0-7]$/);
    expect(lineView(base).time).toBe('');
  });
});

describe('userRows / usersView (R3)', () => {
  const now = Date.parse('2025-01-01T00:00:00Z');
  const users: OnlineUser[] = [
    { handle: 'alice' },
    { handle: 'bob' },
    { handle: 'root', isAdmin: true },
    { handle: 'carol', bannedUntil: '2025-01-01T00:01:05Z' },
  ];
  const viewer = (me = meResponse({ isAdmin: true })) =>
    stateWith((s) => ({ auth: { ...s.auth, token: 't', me }, presence: { ...s.presence, users } }));

  it('marks you, admins and the remaining ban time', () => {
    const rows = userRows(viewer(), now);
    expect(rows.map((r) => [r.handle, r.isSelf, r.isAdmin, r.bannedText])).toEqual([
      ['alice', true, false, null],
      ['bob', false, false, null],
      ['root', false, true, null],
      ['carol', false, false, 'banned · 1m 5s'],
    ]);
  });
  it('lets an admin viewer ban only other non-admin, non-banned users', () => {
    const rows = userRows(viewer(), now);
    expect(rows.map((r) => r.canBan)).toEqual([false, true, false, false]);
    expect(rows[1]?.banLabel).toBe('Ban bob');
  });
  it('gives non-admin viewers no ban buttons', () => {
    expect(userRows(viewer(meResponse()), now).some((r) => r.canBan)).toBe(false);
  });
  it('shows the Ban button again once the ban expired', () => {
    const rows = userRows(viewer(), now + 66_000);
    expect(rows[3]).toMatchObject({ bannedText: null, canBan: true });
  });
  it('disables the button of a user being banned', () => {
    const s = viewer();
    const rows = userRows({ ...s, presence: { ...s.presence, banning: { bob: true } } }, now);
    expect(rows[1]?.banDisabled).toBe(true);
  });
  it('counts everyone incl. you and is empty when only you are online', () => {
    expect(usersView(viewer(), now)).toMatchObject({ count: 4, empty: false });
    const alone = stateWith((s) => ({
      auth: { ...s.auth, token: 't', me: meResponse() },
      presence: { ...s.presence, users: [{ handle: 'alice' }] },
    }));
    expect(usersView(alone, now)).toMatchObject({ count: 1, empty: true });
    expect(usersView(initialState(), now)).toMatchObject({ count: 0, empty: true });
  });
  it('skips malformed entries but still counts them (legacy)', () => {
    const s = stateWith((x) => ({ presence: { ...x.presence, users: [{ handle: '' }, { handle: 'bob' }] } }));
    const v = usersView(s, now);
    expect(v.count).toBe(2);
    expect(v.rows.map((r) => r.handle)).toEqual(['bob']);
  });
});

describe('cardView / logRowView (A3, A4)', () => {
  const row: AdminModerationRow = {
    occurredAt: '2025-01-01T10:00:00Z',
    messageId: 'm1',
    email: 'bob@example.com',
    handle: 'bob',
    status: 'REJECTED',
    score: 0.5,
    text: 'x'.repeat(130),
    reason: 'profanity',
    strikesAfter: 2,
    currentStrikes: 3,
    banState: null,
  };
  const entry = (patch: Partial<AdminModerationRow> = {}, banThreshold: number | null = 3): ModerationEntry => ({
    key: 'm1:REJECTED',
    row: { ...row, ...patch },
    banThreshold,
  });

  it('builds a card with a truncated text and meta line', () => {
    const c = cardView(entry());
    expect(c).toMatchObject({ handle: 'bob', status: 'REJECTED', pillClass: 'pill p-rej' });
    expect(c.text).toBe(`${'x'.repeat(120)}…`);
    expect(c.meta).toEqual(['score 0.50 · strike 2 / 3']);
  });
  it('uses the DLT pill, (unknown) handle and omits the threshold without a profile', () => {
    const c = cardView(entry({ status: 'DLT', handle: null }, null));
    expect(c).toMatchObject({ handle: '(unknown)', pillClass: 'pill p-dlt' });
    expect(c.meta).toEqual(['score 0.50 · strike 2']);
  });
  it('omits the meta line without score and strikes, and adds a ban line', () => {
    expect(cardView(entry({ score: null, strikesAfter: null })).meta).toEqual([]);
    const c = cardView(entry({ banState: { until: '2025-01-01T11:00:00Z' } }));
    expect(c.meta).toHaveLength(2);
    expect(c.meta[1]).toMatch(/^banned until /);
  });
  it('builds the log table row', () => {
    const r = logRowView(entry({ banState: { until: '2025-01-01T11:00:00Z' } }));
    expect(r).toMatchObject({
      email: 'bob@example.com',
      handle: 'bob',
      status: 'REJECTED',
      score: '0.50',
      reason: 'profanity',
      strikes: '2 (now 3)',
    });
    expect(r.ban).toMatch(/^banned until /);
    expect(r.time).not.toBe('');
  });
  it('leaves absent log cells empty', () => {
    const r = logRowView(entry({ score: null, strikesAfter: null, email: null, handle: null, reason: null }));
    expect(r).toMatchObject({ score: '', strikes: '', email: '', handle: '', reason: '', ban: '' });
    expect(logRowView(entry({ currentStrikes: null })).strikes).toBe('2');
  });
});
