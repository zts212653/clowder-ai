import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NewConversationPage } from '@/components/new-conversation/NewConversationPage';
import { ConfirmProvider } from '@/components/useConfirm';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/cat-persona-tokens.css';
import '@/app/cat-persona-derived.css';
import '@/app/connector-tokens.css';
import '@/app/theme-extras.css';
import '@/app/console-tokens.css';
import '@/app/console-shell.css';
import '@/app/console-controls.css';
import '@/app/shell-v2.css';

const ignore = () => {};
function Probe() {
  const [landing, setLanding] = useState(true);
  return (
    <ConfirmProvider>
      <button type="button" data-testid="visit-other" onClick={() => setLanding(false)}>
        Other conversation
      </button>
      <button type="button" data-testid="visit-new" onClick={() => setLanding(true)}>
        New conversation
      </button>
      {landing ? (
        <NewConversationPage
          sidebarOpen={false}
          statusPanelOpen={false}
          hasWorkspaceActivity={false}
          onToggleSidebar={ignore}
          onToggleStatusPanel={ignore}
          onNavigate={ignore}
        />
      ) : (
        <div data-testid="other-conversation">Existing conversation</div>
      )}
    </ConfirmProvider>
  );
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing browser fixture root');
createRoot(rootElement).render(<Probe />);
