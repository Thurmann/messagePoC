import { Banners } from './Banners';
import { ChatView } from './ChatView';
import { HandleDialog } from './HandleDialog';
import { LogView } from './LogView';
import { TopBar } from './TopBar';

export function App() {
  return (
    <>
      <TopBar />
      <Banners />
      <ChatView />
      <LogView />
      <HandleDialog />
    </>
  );
}
