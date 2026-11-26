export type SseEventHandler = (name: string, data: unknown) => void;

export interface SseParser {
  /** Feed the next decoded chunk; complete events are dispatched synchronously. */
  push(chunk: string): void;
}

const LINE_END = /\r\n|\n|\r/;

/**
 * Incremental text/event-stream parser: CR, LF and CRLF line ends, ':' comments, `event:`, multi-line `data:`
 * joined with '\n', blank line dispatches. Events whose data is not valid JSON are dropped.
 */
export function createSseParser(onEvent: SseEventHandler): SseParser {
  let buf = '';
  let eventName = '';
  let data: string[] = [];

  function dispatch(): void {
    if (data.length) {
      try {
        onEvent(eventName || 'message', JSON.parse(data.join('\n')));
      } catch {
        /* bad event */
      }
    }
    eventName = '';
    data = [];
  }

  function handleLine(line: string): void {
    if (line === '') return dispatch();
    if (line.charAt(0) === ':') return; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  }

  return {
    push(chunk) {
      buf += chunk;
      let m: RegExpMatchArray | null;
      while ((m = buf.match(LINE_END))) {
        const idx = m.index!;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + m[0].length);
        handleLine(line);
      }
    },
  };
}
