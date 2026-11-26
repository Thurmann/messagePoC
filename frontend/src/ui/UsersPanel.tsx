import { usersView } from '../core/selectors';
import { useActions, useAppState } from './AppContext';

export function UsersPanel() {
  const actions = useActions();
  const running = useAppState((s) => s.presence.running);
  const view = useAppState((s) => usersView(s));
  return (
    <aside className="users" id="users" aria-label="Online users" hidden={!running}>
      <div className="label" id="users-label">
        Online · <span id="users-count">{view.count}</span>
      </div>
      <ul className="ulist" id="users-list">
        {view.rows.map((u) => (
          <li key={u.handle}>
            <span className={`h ${u.colorClass}`}>{u.handle}</span>
            {u.isSelf && <span className="you">(you)</span>}
            {u.isAdmin && <span className="tag">admin</span>}
            {u.bannedText !== null ? (
              <span className="banned">{u.bannedText}</span>
            ) : (
              u.canBan && (
                <button
                  type="button"
                  className="btn small danger"
                  disabled={u.banDisabled}
                  aria-label={u.banLabel}
                  onClick={() => actions.banUser(u.handle)}
                >
                  Ban
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      <div className="empty" id="users-empty" hidden={!view.empty}>
        No one else is online.
      </div>
      <div className="error" id="users-error" role="alert" hidden={!view.error}>
        {view.error}
      </div>
    </aside>
  );
}
