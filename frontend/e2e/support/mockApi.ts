import type { Page, Route } from '@playwright/test';

export interface PublicEvent {
  type: 'message' | 'removed';
  messageId: string;
  occurredAt: string;
  handle: string;
  text?: string;
}

export interface Me {
  email: string;
  handle: string | null;
  isAdmin: boolean;
  strikes: number;
  warningThreshold: number;
  banThreshold: number;
  warning: boolean;
  ban: { until: string; remainingSeconds: number } | null;
}

export interface OnlineUser {
  handle: string;
  isAdmin?: boolean;
  bannedUntil?: string;
}

export interface ModerationRow {
  occurredAt: string;
  messageId: string;
  email: string;
  handle: string | null;
  status: string;
  score: number | null;
  text: string;
  reason: string | null;
  strikesAfter: number | null;
  currentStrikes: number | null;
  banState: { until: string } | null;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or null when there was none. */
  body: any;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Fail the request like a network error. */
  abort?: boolean;
}

export type Handler = (req: RecordedRequest) => MockResponse | Promise<MockResponse>;

export const HISTORY: PublicEvent[] = [
  { type: 'message', messageId: 'h1', occurredAt: '2030-01-01T10:00:00Z', handle: 'alice', text: 'Hello from alice' },
  { type: 'message', messageId: 'h2', occurredAt: '2030-01-01T10:00:05Z', handle: 'bob', text: 'Hi alice' },
  { type: 'removed', messageId: 'h3', occurredAt: '2030-01-01T10:00:09Z', handle: 'carol' },
];

export const ALICE: Me = {
  email: 'alice@example.com',
  handle: 'alice',
  isAdmin: false,
  strikes: 0,
  warningThreshold: 2,
  banThreshold: 3,
  warning: false,
  ban: null,
};

/**
 * Replaces the whole backend: every /api/** request of the page is answered from this object and recorded.
 * Mutate the state fields for the common cases, or `on('POST /api/messages', handler)` for full control.
 * The two SSE endpoints are not handled here; see FakeStreams.
 */
export class MockApi {
  config: Record<string, unknown> | null = { googleClientId: 'test-client', messageApiBaseUrl: '', version: '1.2.3' };
  history: PublicEvent[] = HISTORY.map((e) => ({ ...e }));
  kafka = 'UP';
  me: Me = { ...ALICE };
  users: OnlineUser[] = [];
  moderationLog: ModerationRow[] = [];
  auditLogs: unknown[] = [];

  readonly requests: RecordedRequest[] = [];
  /** Requests no handler answered; the fixtures fail the test if any remain. */
  readonly unhandled: string[] = [];
  private readonly handlers = new Map<string, Handler>();

  constructor(private readonly page: Page) {
    this.handlers.set('GET /api/config', () => (this.config ? { json: this.config } : { status: 500 }));
    this.handlers.set('GET /api/chat/history', () => ({ json: this.history }));
    this.handlers.set('GET /api/chat/kafka-status', () => ({
      json: { status: this.kafka, since: '2030-01-01T09:00:00Z', checkedAt: '2030-01-01T10:00:00Z' },
    }));
    this.handlers.set('GET /api/me', () => ({ json: this.me }));
    this.handlers.set('PUT /api/me/handle', () => ({ status: 200, json: {} }));
    this.handlers.set('POST /api/me/presence', () => ({ json: { ban: null } }));
    this.handlers.set('DELETE /api/me/presence', () => ({ status: 204 }));
    this.handlers.set('GET /api/users/online', () => ({ json: this.users }));
    this.handlers.set('POST /api/messages', () => ({ status: 202, json: { status: 'PENDING' } }));
    this.handlers.set('POST /api/admin/users/ban', () => ({ status: 200, json: {} }));
    this.handlers.set('GET /api/admin/moderation-log', () => ({ json: this.moderationLog }));
    this.handlers.set('GET /api/audit-logs', () => ({ json: this.auditLogs }));
  }

  async install(): Promise<void> {
    await this.page.route('**/api/**', (route) => this.dispatch(route));
  }

  /** Replaces the handler for `"METHOD /path"`. */
  on(key: string, handler: Handler): void {
    this.handlers.set(key, handler);
  }

  /** Answers `"METHOD /path"` with each response in turn; the last one repeats. */
  sequence(key: string, ...responses: MockResponse[]): void {
    let i = 0;
    this.on(key, () => responses[Math.min(i++, responses.length - 1)]!);
  }

  /** Requests recorded for `"METHOD /path"`, oldest first. */
  calls(key: string): RecordedRequest[] {
    const [method, path] = key.split(' ');
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  private async dispatch(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = null;
    const raw = request.postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const rec: RecordedRequest = {
      method: request.method(),
      path: url.pathname,
      query: url.search,
      headers: request.headers(),
      body,
    };
    this.requests.push(rec);
    const handler = this.handlers.get(`${rec.method} ${rec.path}`);
    if (!handler) {
      this.unhandled.push(`${rec.method} ${rec.path}`);
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      return;
    }
    const res = await handler(rec);
    if (res.abort) {
      await route.abort('failed').catch(() => undefined);
      return;
    }
    const status = res.status ?? 200;
    await route
      .fulfill({
        status,
        headers: res.headers,
        contentType: res.json === undefined ? undefined : 'application/json',
        body: res.json === undefined ? '' : JSON.stringify(res.json),
      })
      .catch(() => undefined); // the page may have navigated away meanwhile
  }
}
