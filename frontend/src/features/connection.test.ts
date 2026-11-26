import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reply } from '../test/fakes';
import { createHarness, emit, type Harness } from '../test/harness';
import { composerView, connView } from '../core/selectors';

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  h = createHarness();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connection state (C1, C4)', () => {
  it('goes live when the stream opens, and reconnecting when it drops', async () => {
    await h.boot();
    expect(connView(h.state())).toMatchObject({ text: 'live', className: 'on' });
    h.publicStreams[0]?.close();
    await h.flush();
    expect(connView(h.state())).toMatchObject({ text: 'reconnecting…', className: '' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.publicStreams).toHaveLength(2);
    expect(connView(h.state())).toMatchObject({ text: 'live', className: 'on' });
  });

  it('shows the Kafka warning and composer placeholder when Kafka is DOWN', async () => {
    h.deps.fakeFetch.on('GET', '/api/chat/kafka-status', () => reply(200, { status: 'DOWN' }));
    await h.bootSignedIn();
    expect(connView(h.state())).toMatchObject({ text: 'live · Kafka unavailable, messages delayed', className: 'warn' });
    expect(composerView(h.state()).placeholder).toBe('Write a message (Kafka unavailable, messages may be delayed)');
  });

  it('follows kafka stream events: DOWN then UP', async () => {
    await h.boot();
    await emit(h.publicStreams[0], 'kafka', { status: 'DOWN' });
    expect(h.state().conn.kafka).toBe('DOWN');
    await emit(h.publicStreams[0], 'kafka', { status: 'UP' });
    expect(h.state().conn.kafka).toBe('UP');
  });

  it('maps unknown kafka statuses to UNKNOWN', async () => {
    await h.boot();
    await emit(h.publicStreams[0], 'kafka', { status: 'WAT' });
    expect(h.state().conn.kafka).toBe('UNKNOWN');
    await emit(h.publicStreams[0], 'kafka', null);
    expect(h.state().conn.kafka).toBe('UNKNOWN');
  });

  it('keeps the Kafka status of a failed status request unchanged', async () => {
    h.deps.fakeFetch.on('GET', '/api/chat/kafka-status', () => reply(500, {}));
    await h.boot();
    expect(h.state().conn.kafka).toBe('UNKNOWN');
  });
});

describe('Kafka status race (C3)', () => {
  it('ignores a status fetch result when a kafka stream event arrived meanwhile', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('GET', '/api/chat/kafka-status', () => new Promise<Response>((r) => (release = r)));
    await h.boot();
    await emit(h.publicStreams[0], 'kafka', { status: 'DOWN' });
    release(reply(200, { status: 'UP' })); // stale answer from before the event
    await h.flush();
    expect(h.state().conn.kafka).toBe('DOWN');
  });

  it('applies a status fetch result when no event arrived meanwhile', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('GET', '/api/chat/kafka-status', () => new Promise<Response>((r) => (release = r)));
    await h.boot();
    release(reply(200, { status: 'DOWN' }));
    await h.flush();
    expect(h.state().conn.kafka).toBe('DOWN');
  });
});

describe('history (C2)', () => {
  const history = [
    { type: 'message', messageId: 'a', occurredAt: '2025-03-01T10:00:00Z', handle: 'bob', text: 'one' },
    { type: 'removed', messageId: 'b', occurredAt: '2025-03-01T10:00:01Z', handle: 'eve' },
    { type: 'message', messageId: 'c', occurredAt: '2025-03-01T10:00:02Z', handle: 'bob', text: 'two' },
  ];

  it('loads history (limit 100, uncached) after the stream opens, oldest first', async () => {
    h.deps.fakeFetch.on('GET', '/api/chat/history', () => reply(200, history));
    await h.boot();
    expect(h.deps.fakeFetch.fetch).toHaveBeenCalledWith('/api/chat/history?limit=100', { cache: 'no-store' });
    expect(h.state().lines.map((l) => l.key)).toEqual(['a', 'b', 'c']);
  });

  it('reloads history after a reconnect and on resync without duplicating lines', async () => {
    h.deps.fakeFetch.on('GET', '/api/chat/history', () => reply(200, history));
    await h.boot();
    h.publicStreams[0]?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/chat/history')).toHaveLength(2);
    await emit(h.publicStreams[1], 'resync', {});
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/chat/history')).toHaveLength(3);
    expect(h.state().lines).toHaveLength(3);
  });

  it('also reloads the Kafka status after every reconnect', async () => {
    await h.boot();
    const before = h.deps.fakeFetch.requestsTo('GET', '/api/chat/kafka-status').length;
    h.publicStreams[0]?.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.deps.fakeFetch.requestsTo('GET', '/api/chat/kafka-status').length).toBe(before + 1);
  });

  it('ignores a failing history request', async () => {
    h.deps.fakeFetch.on('GET', '/api/chat/history', () => reply(500, {}));
    await h.boot();
    expect(h.state().lines).toEqual([]);
    h.deps.fakeFetch.on('GET', '/api/chat/history', () => {
      throw new Error('offline');
    });
    await emit(h.publicStreams[0], 'resync', {});
    expect(h.state().lines).toEqual([]);
  });

  it('drops events with bad JSON and keeps handling later ones (C5)', async () => {
    await h.boot();
    h.publicStreams[0]?.push('event: message\ndata: {not json}\n\n');
    await emit(h.publicStreams[0], 'message', { messageId: 'x', handle: 'bob', text: 'ok', occurredAt: '2025-03-01T10:00:00Z' });
    expect(h.state().lines.map((l) => l.key)).toEqual(['x']);
  });
});
