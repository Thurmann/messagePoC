import { cardView } from '../core/selectors';
import { useActions, useAppState } from './AppContext';

export function ModerationRail() {
  const actions = useActions();
  const isAdmin = useAppState((s) => !!(s.auth.token && s.auth.me?.isAdmin));
  const cards = useAppState((s) => s.admin.entries.map(cardView));
  const audit = useAppState((s) => s.admin.audit);
  return (
    <aside className="rail" id="rail" aria-label="Moderation" hidden={!isAdmin}>
      <div className="label">Moderation</div>
      <div className="cards" id="cards">
        {cards.map((c) => (
          <div key={c.key} className="card">
            <div className="top">
              <b className={c.colorClass}>{c.handle}</b>
              <span className={c.pillClass}>{c.status}</span>
            </div>
            <div className="q">{c.text}</div>
            {c.meta.map((m, i) => (
              <div key={i} className="meta">
                {m}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="empty" id="rail-empty" hidden={cards.length > 0}>
        No flagged messages yet.
      </div>
      <button type="button" className="btn ghost" id="audit-btn" onClick={() => actions.loadAudit()}>
        Load audit logs
      </button>
      <ul className="audit" id="audit">
        {audit?.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </aside>
  );
}
