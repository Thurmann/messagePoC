import type { AdminModerationRow, KafkaStatus, MeResponse, OnlineUser } from '../api/types';

export interface AppConfig {
  googleClientId: string;
  messageApiBaseUrl: string;
  version: string;
}

/** One row of the chat log: a user message (own or received) or a system line. */
export interface ChatLine {
  /** The messageId; stable across status changes so the UI can reuse the element. */
  key: string;
  kind: 'user' | 'sys';
  handle?: string;
  text: string;
  /** ISO instant; formatted by the UI. Own lines keep their local send time after they resolve. */
  time?: string;
  pending: boolean;
  unconfirmed: boolean;
  failed: boolean;
  /** The ".status" suffix text, or null for none. */
  status: string | null;
}

/** A moderation result with the ban threshold that was known when it arrived (cards show "strike N / threshold"). */
export interface ModerationEntry {
  key: string;
  row: AdminModerationRow;
  banThreshold: number | null;
}

export interface AppState {
  config: AppConfig;
  conn: {
    /** null until the first connection result. */
    sse: boolean | null;
    kafka: KafkaStatus;
  };
  auth: {
    token: string | null;
    me: MeResponse | null;
    /** Mirrors the Google sign-in readiness as of the last syncMe (the legacy app showed the login button then). */
    gisReady: boolean;
    setupNotice: string | null;
  };
  lines: ChatLine[];
  sendError: string;
  /** Controlled composer text. */
  draft: string;
  /** Text of the warning banner, or null when hidden. */
  warnText: string | null;
  /** Active ban: end (epoch ms) and the remaining-time label refreshed each second. */
  ban: { until: number; label: string } | null;
  presence: {
    running: boolean;
    users: OnlineUser[];
    banning: Record<string, true>;
    error: string;
    /** Epoch ms of the last presence render; drives "banned · X" countdowns. */
    now: number;
  };
  admin: {
    tab: 'chat' | 'log';
    /** Newest first. */
    entries: ModerationEntry[];
    /** null until the audit button was used. */
    audit: string[] | null;
  };
  dialog: {
    open: boolean;
    /** Bumped on every open request so the UI re-focuses the input even if already open. */
    openSeq: number;
    error: string;
    saving: boolean;
  };
}

export function initialState(): AppState {
  return {
    config: { googleClientId: '', messageApiBaseUrl: '', version: '' },
    conn: { sse: null, kafka: 'UNKNOWN' },
    auth: { token: null, me: null, gisReady: false, setupNotice: null },
    lines: [],
    sendError: '',
    draft: '',
    warnText: null,
    ban: null,
    presence: { running: false, users: [], banning: {}, error: '', now: 0 },
    admin: { tab: 'chat', entries: [], audit: null },
    dialog: { open: false, openSeq: 0, error: '', saving: false },
  };
}
