import { layoutView } from '../core/selectors';
import { useAppState } from './AppContext';
import { ChatPanel } from './ChatPanel';
import { ModerationRail } from './ModerationRail';
import { UsersPanel } from './UsersPanel';

export function ChatView() {
  const layout = useAppState(layoutView);
  const cls = ['layout', layout.noUsers && 'no-users', layout.noRail && 'no-rail'].filter(Boolean).join(' ');
  return (
    <main id="view-chat" className={cls} hidden={!layout.showChat}>
      <UsersPanel />
      <ChatPanel />
      <ModerationRail />
    </main>
  );
}
