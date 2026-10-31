import { useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ChatMessage } from '@/components/ChatMessage';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadRowSignals } from '@/components/ThreadSidebar/ThreadRowSignals';
import { getThreadIdFromPathname, subscribeBrowserThreadRoute } from '@/components/ThreadSidebar/thread-navigation';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { useThemeStore } from '@/stores/themeStore';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

primeCoCreatorConfigCache({ name: 'Proof owner', aliases: [], mentionPatterns: ['@co-creator'] });
const params = new URLSearchParams(location.search);
if (localStorage.getItem('cat-cafe:shell-presentation') === 'v2') document.documentElement.dataset.shell = 'v2';
useThemeStore.getState().setActive(params.get('base') === 'dark' ? 'dark' : 'light');

function LetterConversation({ threadId }: { threadId: string }) {
  const { scrollContainerRef, messagesEndRef, handleScroll } = useChatHistory(threadId);
  const messages = useThreadMessages(threadId);
  const { getCatById } = useCatData();
  return (
    <section
      style={{
        width: Math.min(Number(params.get('width') || 720), window.innerWidth - 24),
        margin: 12,
        background: 'var(--shell-work)',
      }}
    >
      <div data-letter-attention>
        <ThreadRowSignals
          presence={{ status: 'idle', cats: [] }}
          unreadCount={messages.length}
          hasUserMention={messages.some((m) => m.mentionsUser)}
          hasDraft={false}
        />
      </div>
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        data-letter-scroll
        style={{ height: 650, overflowY: 'auto', padding: 16 }}
      >
        {messages.map((message) => (
          <MessageViewportBoundary key={message.id} messageId={message.id} eager>
            <ChatMessage message={message} threadId={threadId} timelineMessages={messages} getCatById={getCatById} />
          </MessageViewportBoundary>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </section>
  );
}

function Host() {
  const threadId = useSyncExternalStore(subscribeBrowserThreadRoute, () => getThreadIdFromPathname(location.pathname));
  useEffect(() => {
    useChatStore.getState().setCurrentThread(threadId);
  }, [threadId]);
  return (
    <ThreadChatHistoryAdmissionProvider>
      <LetterConversation key={threadId} threadId={threadId} />
    </ThreadChatHistoryAdmissionProvider>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing letter proof root');
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <Host />
  </ThemeProvider>,
);
