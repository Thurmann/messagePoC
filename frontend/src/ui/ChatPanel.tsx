import { useLayoutEffect, useRef, type FormEvent } from 'react';
import { composerView, lineView } from '../core/selectors';
import { useActions, useAppState } from './AppContext';

function ChatLog() {
  const lines = useAppState((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  function onScroll(): void {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  return (
    <div className="lines" id="lines" role="log" aria-live="polite" ref={ref} onScroll={onScroll}>
      {lines.map((line) => {
        const v = lineView(line);
        if (v.sys) {
          return (
            <div key={v.key} className={v.className}>
              {v.text}
            </div>
          );
        }
        return (
          <div key={v.key} className={v.className}>
            {v.time && <span className="t">{v.time}</span>}
            <span className={`h ${v.colorClass}`}>{v.handle}</span>
            {': '}
            <span className="x">{v.text}</span>
            {v.status !== null && <span className="status">{v.status}</span>}
          </div>
        );
      })}
    </div>
  );
}

function Composer() {
  const actions = useActions();
  const draft = useAppState((s) => s.draft);
  const view = useAppState(composerView);
  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    actions.submit();
  }
  return (
    <form className="composer" id="composer" autoComplete="off" onSubmit={onSubmit}>
      <input
        type="text"
        id="text"
        maxLength={500}
        placeholder={view.placeholder}
        aria-label="Message"
        disabled={view.disabled}
        value={draft}
        onChange={(e) => actions.setDraft(e.target.value)}
      />
      <button type="submit" className="btn primary" id="send" disabled={view.disabled}>
        Send
      </button>
    </form>
  );
}

export function ChatPanel() {
  const sendError = useAppState((s) => s.sendError);
  return (
    <section className="chat frame" aria-label="Chat">
      <ChatLog />
      <div className="error" id="send-error" role="alert" hidden={!sendError}>
        {sendError}
      </div>
      <Composer />
    </section>
  );
}
