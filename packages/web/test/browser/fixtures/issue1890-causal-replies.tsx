import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { ThreadChatSurface } from '@/components/thread-chat/ThreadChatSurface';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { readChatScrollState, saveChatScrollState } from '@/utils/chat-scroll-memory';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';
import '@/app/cat-persona-tokens.css';
import '@/app/cat-persona-derived.css';
import '@/app/connector-tokens.css';
import '@/app/theme-extras.css';
import '@/app/console-shell.css';
import '@/app/console-controls.css';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

primeCoCreatorConfigCache({ name: 'Isolated owner', aliases: [], mentionPatterns: [] });
const threadId = new URLSearchParams(window.location.search).get('thread') ?? 'issue1890';
if (new URLSearchParams(window.location.search).has('fresh'))
  saveChatScrollState(threadId, { top: 0, anchor: 'bottom' });
document.documentElement.setAttribute('data-shell', 'v2');
useChatStore.setState({ currentThreadId: threadId, currentProjectPath: '/isolated/issue1890' });
useChatStore.subscribe((state) => {
  if (state.pendingChatInsert) Object.assign(window, { issue1890LastInsert: state.pendingChatInsert });
});
Object.assign(window, {
  issue1890Focus: focusLineageMessage,
  issue1890Hydrate: (messages: ChatMessage[]) => useChatStore.getState().hydrateThread(threadId, messages, false),
  issue1890Shell: (shell: 'v2' | 'classic') => {
    writeShellPresentation(shell);
    document.documentElement.setAttribute('data-shell', shell);
  },
  issue1890State: () => ({
    messages: useChatStore.getState().getThreadState(threadId).messages,
    hasMore: useChatStore.getState().getThreadState(threadId).hasMore,
    isLoadingHistory: useChatStore.getState().isLoadingHistory,
    reading: readChatScrollState(threadId),
    pending: useChatStore.getState().pendingChatInsert,
  }),
});

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <ThemeProvider>
      <CatHueInjector />
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <ThreadChatRuntimeProvider routeThreadId={threadId}>
          <ThreadChatSurface threadId={threadId} density="full" />
        </ThreadChatRuntimeProvider>
      </div>
    </ThemeProvider>,
  );
