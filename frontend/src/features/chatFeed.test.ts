import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lineView } from '../core/selectors';
import { createHarness, emit, type Harness } from '../test/harness';

let h: Harness;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-03-01T12:00:00Z'));
  h = createHarness();
  await h.boot();
});
afterEach(() => {
  vi.useRealTimers();
});

const stream = () => h.publicStreams[0];
const message = (id: string, handle = 'bob', text = 'hi') => ({
  messageId: id,
  handle,
  text,
  occurredAt: '2025-03-01T10:00:00Z',
});

describe('incoming events (F1, F4, F5)', () => {
  it('F4 appends a user line with the handle, text and event time', async () => {
    await emit(stream(), 'message', message('m1'));
    expect(h.state().lines).toEqual([
      {
        key: 'm1',
        kind: 'user',
        handle: 'bob',
        text: 'hi',
        time: '2025-03-01T10:00:00Z',
        pending: false,
        unconfirmed: false,
        failed: false,
        status: null,
      },
    ]);
    expect(lineView(h.state().lines[0]!).colorClass).toMatch(/^c[0-7]$/);
  });

  it('F5 an unknown removed event becomes a system line', async () => {
    await emit(stream(), 'removed', { messageId: 'm1', handle: 'eve', occurredAt: '2025-03-01T10:00:00Z' });
    expect(h.state().lines[0]).toMatchObject({
      kind: 'sys',
      text: 'A message from eve was removed by moderation.',
    });
    expect(lineView(h.state().lines[0]!).className).toBe('line sys');
  });

  it('F1 ignores events without a messageId', async () => {
    await emit(stream(), 'message', { handle: 'bob', text: 'hi' });
    await emit(stream(), 'message', null);
    expect(h.state().lines).toEqual([]);
  });

  it('F1 dedupes by messageId across events (and later removed events for the same id)', async () => {
    await emit(stream(), 'message', message('m1'));
    await emit(stream(), 'message', message('m1', 'bob', 'changed'));
    await emit(stream(), 'removed', { messageId: 'm1', handle: 'bob' });
    expect(h.state().lines).toHaveLength(1);
    expect(h.state().lines[0]?.text).toBe('hi');
  });

  it('keeps arrival order and replaces state immutably', async () => {
    await emit(stream(), 'message', message('m1'));
    const before = h.state().lines;
    await emit(stream(), 'message', message('m2'));
    expect(before).toHaveLength(1);
    expect(h.state().lines.map((l) => l.key)).toEqual(['m1', 'm2']);
  });
});
