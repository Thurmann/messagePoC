// Mirrors the Kotlin DTOs in services/message-persistence. Instants arrive as ISO-8601 strings.

export interface ClientConfig {
  googleClientId: string;
  messageApiBaseUrl: string;
  version: string;
}

export interface PublicChatEvent {
  type: 'message' | 'removed';
  messageId: string;
  occurredAt: string;
  handle: string;
  /** Present on 'message' only. */
  text?: string;
}

export type KafkaStatus = 'UNKNOWN' | 'UP' | 'DOWN';

export interface KafkaStatusView {
  status: string;
  since: string | null;
  checkedAt: string | null;
}

export interface BanInfo {
  until: string;
  remainingSeconds: number;
}

export interface MeResponse {
  email: string;
  handle: string | null;
  isAdmin: boolean;
  strikes: number;
  warningThreshold: number;
  banThreshold: number;
  warning: boolean;
  ban: BanInfo | null;
}

export interface PresenceResponse {
  ban: BanInfo | null;
}

/** isAdmin and bannedUntil are only sent to admin callers; null fields are omitted. */
export interface OnlineUser {
  handle: string;
  isAdmin?: boolean;
  bannedUntil?: string;
}

export type MessageResultStatus = 'VALIDATED' | 'REJECTED' | 'DLT';

export interface AdminModerationRow {
  occurredAt: string;
  messageId: string;
  email: string | null;
  handle: string | null;
  status: MessageResultStatus;
  score: number | null;
  text: string;
  reason: string | null;
  strikesAfter: number | null;
  currentStrikes: number | null;
  banState: { until: string } | null;
}

export interface AuditLogEntry {
  timestamp: string;
  message: string;
  result: string | null;
  text: string | null;
  messageId: string | null;
  correlationId: string | null;
  profanityScore: number | null;
}

/** Error body of the message/handle/ban endpoints, e.g. {error: 'BANNED', bannedUntil, remainingSeconds}. */
export interface ApiErrorBody {
  error?: string;
  status?: string;
  bannedUntil?: string;
  remainingSeconds?: number;
}
