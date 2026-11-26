import { layoutView, sessionView, versionView } from '../core/selectors';
import { useActions, useAppState } from './AppContext';
import { ConnIndicator } from './ConnIndicator';
import { ThemeToggle } from './ThemeToggle';

export function TopBar() {
  const actions = useActions();
  const layout = useAppState(layoutView);
  const session = useAppState(sessionView);
  const version = useAppState(versionView);
  const tab = useAppState((s) => s.admin.tab);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="eyebrow">Message PoC</span>
        <h1>Live chat</h1>
      </div>
      <nav className="tabs" id="tabs" hidden={!layout.showTabs}>
        <button
          type="button"
          className={tab === 'chat' ? 'tab active' : 'tab'}
          id="tab-chat"
          data-tab="chat"
          onClick={() => actions.switchTab('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={tab === 'log' ? 'tab active' : 'tab'}
          id="tab-log"
          data-tab="log"
          onClick={() => actions.switchTab('log')}
        >
          Admin log
        </button>
      </nav>
      <div className="auth">
        <ThemeToggle />
        <ConnIndicator />
        <span className="version" id="version" title={version.title || undefined} hidden={!version.visible}>
          {version.text}
        </span>
        <div id="me" className="me" hidden={!session.signed}>
          <span className="me-handle" id="me-handle">
            {session.meLabel}
          </span>
          <button type="button" className="btn ghost" id="signout" onClick={() => actions.signOut()}>
            Sign out
          </button>
        </div>
        <div id="login" className="login" hidden={!session.showLogin}>
          <span className="btn primary" aria-hidden="true">
            Login
          </span>
          <div id="gsi-button" className="login-gsi" title="Login" />
        </div>
      </div>
    </header>
  );
}
