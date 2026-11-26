import type { PublicChatEvent } from '../api/types';
import { sseContext, patchSlice, type Ctx } from '../core/ctx';
import { startSse } from '../sse/stream';

export interface ConnectionService {
  /** Starts the public chat stream and loads the Kafka status once. */
  start(): void;
}

export function createConnection(ctx: Ctx): ConnectionService {
  const { deps } = ctx;
  let kafkaVer = 0;

  function setKafka(status: unknown): void {
    patchSlice(ctx, 'conn', { kafka: status === 'UP' || status === 'DOWN' ? status : 'UNKNOWN' });
  }

  async function loadKafkaStatus(): Promise<void> {
    const ver = kafkaVer;
    try {
      const res = await deps.fetch('/api/chat/kafka-status', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { status?: unknown } | null;
      if (ver === kafkaVer) setKafka(body?.status); // ignore if a newer stream event arrived meanwhile
    } catch {
      /* ignore */
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      const res = await deps.fetch('/api/chat/history?limit=100', { cache: 'no-store' });
      if (!res.ok) return;
      const list = (await res.json()) as PublicChatEvent[];
      list.forEach((ev) => ctx.chatFeed.handleChatEvent(ev.type, ev));
    } catch {
      /* ignore */
    }
  }

  function onEvent(name: string, data: unknown): void {
    if (name === 'message' || name === 'removed') ctx.chatFeed.handleChatEvent(name, data);
    else if (name === 'kafka') {
      kafkaVer++;
      setKafka((data as { status?: unknown } | null)?.status);
    } else if (name === 'resync') void loadHistory();
  }

  function start(): void {
    startSse(sseContext(ctx), '/api/chat/stream', {
      withAuth: false,
      onEvent,
      onState: (on) => patchSlice(ctx, 'conn', { sse: on }),
      afterConnect: () => {
        void loadHistory();
        void loadKafkaStatus();
      },
    });
    void loadKafkaStatus();
  }

  return { start };
}
