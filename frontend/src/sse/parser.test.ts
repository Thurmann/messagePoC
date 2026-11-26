import { describe, expect, it } from 'vitest';
import { createSseParser } from './parser';

function collect() {
  const events: [string, unknown][] = [];
  const parser = createSseParser((name, data) => events.push([name, data]));
  return { events, parser };
}

describe('createSseParser', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('parses %s line ends', (_n, eol) => {
    const { events, parser } = collect();
    parser.push(`event: message${eol}data: {"a":1}${eol}${eol}`);
    expect(events).toEqual([['message', { a: 1 }]]);
  });

  it('defaults the event name to "message"', () => {
    const { events, parser } = collect();
    parser.push('data: {"x":true}\n\n');
    expect(events).toEqual([['message', { x: true }]]);
  });

  it('handles chunks split anywhere, including mid-field and mid-JSON', () => {
    const { events, parser } = collect();
    const text = 'event: kafka\ndata: {"status":"UP"}\n\nevent: resync\ndata: {}\n\n';
    for (const ch of text) parser.push(ch);
    expect(events).toEqual([
      ['kafka', { status: 'UP' }],
      ['resync', {}],
    ]);
  });

  it('ignores comments and heartbeats', () => {
    const { events, parser } = collect();
    parser.push(':connected\n\n:ping\n\nevent: a\n:inline comment\ndata: 1\n\n');
    expect(events).toEqual([['a', 1]]);
  });

  it('joins multiple data lines with a newline', () => {
    const { events, parser } = collect();
    parser.push('data: {"a":\ndata: 1}\n\n');
    expect(events).toEqual([['message', { a: 1 }]]);
  });

  it('strips exactly one leading space from values', () => {
    const { events, parser } = collect();
    parser.push('event:  spaced\ndata:{"v":"  x"}\n\n');
    expect(events).toEqual([[' spaced', { v: '  x' }]]);
  });

  it('drops events whose data is not valid JSON and keeps parsing', () => {
    const { events, parser } = collect();
    parser.push('data: not json\n\ndata: {"ok":1}\n\n');
    expect(events).toEqual([['message', { ok: 1 }]]);
  });

  it('does not dispatch events without data and resets the event name', () => {
    const { events, parser } = collect();
    parser.push('event: lonely\n\ndata: 2\n\n');
    expect(events).toEqual([['message', 2]]);
  });

  it('waits for the blank line before dispatching', () => {
    const { events, parser } = collect();
    parser.push('data: 1\n');
    expect(events).toEqual([]);
    parser.push('\n');
    expect(events).toEqual([['message', 1]]);
  });

  it('ignores unknown fields', () => {
    const { events, parser } = collect();
    parser.push('id: 7\nretry: 100\ndata: 3\n\n');
    expect(events).toEqual([['message', 3]]);
  });

  it('treats a field line without colon as the field name with empty value', () => {
    const { events, parser } = collect();
    parser.push('data\ndata: 4\n\n');
    // "data" alone pushes an empty line: joined "\n4" is still valid JSON whitespace + 4
    expect(events).toEqual([['message', 4]]);
  });

  it('keeps going when the handler throws', () => {
    const seen: unknown[] = [];
    const parser = createSseParser((_n, d) => {
      seen.push(d);
      if (d === 1) throw new Error('boom');
    });
    parser.push('data: 1\n\ndata: 2\n\n');
    expect(seen).toEqual([1, 2]);
  });
});
