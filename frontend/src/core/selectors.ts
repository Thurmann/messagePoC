import type { OnlineUser } from '../api/types';
import { banText, colorClass, fmtDateTime, fmtRemaining, fmtTime, truncate } from '../lib/format';
import type { AppState, ChatLine, ModerationEntry } from './state';

// Pure derivations of what the DOM shows; the UI renders these and holds no logic of its own.

export interface ConnView {
  text: string;
  title: string;
  /** '' | 'on' | 'warn' (added to the "conn" class). */
  className: '' | 'on' | 'warn';
}

export function connView(state: AppState): ConnView {
  const { sse, kafka } = state.conn;
  if (sse === null) return { text: 'offline', title: 'Stream connection', className: '' };
  if (!sse) {
    return {
      text: 'reconnecting…',
      title: 'Connection to the chat stream lost; reconnecting.',
      className: '',
    };
  }
  if (kafka === 'DOWN') {
    return {
      text: 'live · Kafka unavailable, messages delayed',
      title:
        'Live updates work, but the message broker is unavailable. Messages you send are retried until confirmed.',
      className: 'warn',
    };
  }
  return { text: 'live', title: 'Connected to the live chat stream.', className: 'on' };
}

export interface VersionView {
  visible: boolean;
  text: string;
  title: string;
}

export function versionView(state: AppState): VersionView {
  const v = state.config.version;
  return v
    ? { visible: true, text: `v${v}`, title: `Running version ${v}` }
    : { visible: false, text: '', title: '' };
}

export interface SessionView {
  /** Token and profile both present. */
  signed: boolean;
  isAdmin: boolean;
  /** "@handle", or the email while no handle is chosen. */
  meLabel: string;
  showLogin: boolean;
}

export function sessionView(state: AppState): SessionView {
  const { token, me, gisReady } = state.auth;
  const signed = !!(token && me);
  return {
    signed,
    isAdmin: signed && !!me?.isAdmin,
    meLabel: signed && me ? (me.handle ? `@${me.handle}` : me.email) : '',
    showLogin: !signed && gisReady,
  };
}

export interface LayoutView {
  showTabs: boolean;
  showRail: boolean;
  showUsers: boolean;
  noRail: boolean;
  noUsers: boolean;
  showChat: boolean;
  showLog: boolean;
}

export function layoutView(state: AppState): LayoutView {
  const admin = sessionView(state).isAdmin;
  const users = state.presence.running;
  const log = state.admin.tab === 'log';
  return {
    showTabs: admin,
    showRail: admin,
    showUsers: users,
    noRail: !admin,
    noUsers: !users,
    showChat: !log,
    showLog: log,
  };
}

export interface ComposerView {
  disabled: boolean;
  placeholder: string;
}

export function composerView(state: AppState): ComposerView {
  const { token, me } = state.auth;
  const signed = !!(token && me);
  const banned = state.ban !== null;
  const ok = signed && !!me?.handle && !banned;
  let placeholder: string;
  if (!signed || !me) placeholder = 'Sign in to chat';
  else if (!me.handle) placeholder = 'Choose a handle to chat';
  else if (banned) placeholder = 'You are temporarily banned';
  else if (state.conn.kafka === 'DOWN') placeholder = 'Write a message (Kafka unavailable, messages may be delayed)';
  else placeholder = 'Write a message';
  return { disabled: !ok, placeholder };
}

export function banBannerText(state: AppState): string | null {
  return state.ban ? `You are temporarily banned from posting. Time remaining: ${state.ban.label}` : null;
}

export interface LineView {
  key: string;
  className: string;
  sys: boolean;
  time: string;
  handle: string;
  colorClass: string;
  text: string;
  status: string | null;
}

export function lineView(line: ChatLine): LineView {
  const flags = [line.kind === 'sys' ? 'sys' : '', line.pending ? 'pending' : '', line.unconfirmed ? 'unconfirmed' : '', line.failed ? 'failed' : ''];
  return {
    key: line.key,
    className: ['line', ...flags.filter(Boolean)].join(' '),
    sys: line.kind === 'sys',
    time: line.time ? fmtTime(line.time) : '',
    handle: line.handle ?? '',
    colorClass: colorClass(line.handle),
    text: line.text,
    status: line.status,
  };
}

export interface UserRow {
  handle: string;
  colorClass: string;
  isSelf: boolean;
  isAdmin: boolean;
  /** "banned · 1m 5s" while banned, else null. */
  bannedText: string | null;
  /** The viewer is an admin and may ban this user. */
  canBan: boolean;
  banDisabled: boolean;
  banLabel: string;
}

function bannedLeft(user: OnlineUser, now: number): number {
  const until = user.bannedUntil ? Date.parse(user.bannedUntil) : NaN;
  return Number.isNaN(until) ? 0 : (until - now) / 1000;
}

export function userRows(state: AppState, now: number): UserRow[] {
  const me = state.auth.me;
  const viewerAdmin = !!me?.isAdmin;
  const rows: UserRow[] = [];
  for (const u of state.presence.users) {
    if (!u || !u.handle) continue;
    const isSelf = u.handle === (me ? me.handle : null);
    const left = bannedLeft(u, now);
    rows.push({
      handle: u.handle,
      colorClass: colorClass(u.handle),
      isSelf,
      isAdmin: !!u.isAdmin,
      bannedText: left > 0 ? `banned · ${fmtRemaining(left)}` : null,
      canBan: left <= 0 && viewerAdmin && !isSelf && !u.isAdmin,
      banDisabled: !!state.presence.banning[u.handle],
      banLabel: `Ban ${u.handle}`,
    });
  }
  return rows;
}

export interface UsersView {
  /** Total entries including you (not only the valid rows). */
  count: number;
  /** No one but you is online. */
  empty: boolean;
  rows: UserRow[];
  error: string;
}

export function usersView(state: AppState, now: number = state.presence.now): UsersView {
  const rows = userRows(state, now);
  return {
    count: state.presence.users.length,
    empty: rows.every((r) => r.isSelf),
    rows,
    error: state.presence.error,
  };
}

export interface CardView {
  key: string;
  handle: string;
  colorClass: string;
  status: string;
  pillClass: string;
  text: string;
  /** Meta lines: "score 0.12 · strike 1 / 3" and, for banned users, "banned until …". */
  meta: string[];
}

function pillClass(status: string): string {
  return `pill ${status === 'DLT' ? 'p-dlt' : 'p-rej'}`;
}

export function cardView({ key, row, banThreshold }: ModerationEntry): CardView {
  const parts: string[] = [];
  if (row.score !== null && row.score !== undefined) parts.push(`score ${Number(row.score).toFixed(2)}`);
  if (row.strikesAfter !== null && row.strikesAfter !== undefined) {
    parts.push(`strike ${row.strikesAfter}${banThreshold !== null ? ` / ${banThreshold}` : ''}`);
  }
  const meta = parts.length ? [parts.join(' · ')] : [];
  if (row.banState) meta.push(banText(row));
  return {
    key,
    handle: row.handle || '(unknown)',
    colorClass: colorClass(row.handle),
    status: row.status,
    pillClass: pillClass(row.status),
    text: truncate(row.text, 120),
    meta,
  };
}

export interface LogRowView {
  key: string;
  time: string;
  email: string;
  handle: string;
  status: string;
  pillClass: string;
  score: string;
  text: string;
  reason: string;
  strikes: string;
  ban: string;
}

export function logRowView({ key, row }: ModerationEntry): LogRowView {
  return {
    key,
    time: fmtDateTime(row.occurredAt),
    email: row.email || '',
    handle: row.handle || '',
    status: row.status,
    pillClass: pillClass(row.status),
    score: row.score == null ? '' : Number(row.score).toFixed(2),
    text: row.text ?? '',
    reason: row.reason || '',
    strikes:
      row.strikesAfter == null
        ? ''
        : String(row.strikesAfter) + (row.currentStrikes == null ? '' : ` (now ${row.currentStrikes})`),
    ban: banText(row),
  };
}
