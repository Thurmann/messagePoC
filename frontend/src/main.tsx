import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import './app.css';
import { createApp } from './core/app';
import { browserDeps } from './core/deps';
import { App } from './ui/App';
import { AppProvider } from './ui/AppContext';

const app = createApp(browserDeps);
const container = document.getElementById('root');
if (!container) throw new Error('#root is missing');

// Render synchronously so #gsi-button exists before Google renders its button into it.
flushSync(() => {
  createRoot(container).render(
    <StrictMode>
      <AppProvider app={app}>
        <App />
      </AppProvider>
    </StrictMode>,
  );
});

window.addEventListener('pageshow', (e) => app.actions.pageShow(e.persisted));
void app.start();
