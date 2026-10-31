import { createRoot } from 'react-dom/client';
import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { CloudConversationLink } from '@/components/CloudConversationLink';
import { PluginsContent } from '@/components/settings/PluginsContent';
import { ConfirmProvider } from '@/components/useConfirm';
import { ReplyStateJourney } from './f247-reply-state';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

const element = document.getElementById('root');
if (!element) throw new Error('Missing fixture root');
createRoot(element).render(
  <ConfirmProvider>
    {window.location.pathname === '/reply-state' ? (
      <ReplyStateJourney />
    ) : window.location.pathname === '/settings' ? (
      <PluginsContent />
    ) : (
      <main className="mx-auto max-w-3xl p-4">
        <h1 className="text-lg font-semibold text-cafe">继续与砚砚 Pro 的对话</h1>
        <CloudBindingRecoveryCard
          threadId="thread-pro"
          sourceMessageId="source-pro"
          targetCatId="gpt-pro"
          attemptId="attempt-pro"
        />
        <CloudConversationLink threadId="thread-pro" />
      </main>
    )}
  </ConfirmProvider>,
);
