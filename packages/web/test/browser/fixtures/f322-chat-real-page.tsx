import { useCallback, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';
import { ChatInput } from '@/components/ChatInput';
import { ChatMessage } from '@/components/ChatMessage';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { scopedQueue } from '@/components/execution-row/thread-queue';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { useShellPresentation, writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadComposerContext } from '@/components/ThreadComposerContext';
import { ThreadSidebar } from '@/components/ThreadSidebar/ThreadSidebar';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { ThreadChatSurface } from '@/components/thread-chat/ThreadChatSurface';
import type { ChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import { syncDraftToStorage } from '@/components/thread-drafts';
import { ResizeHandle } from '@/components/workspace/ResizeHandle';
import { useCatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useConversationViewPreference } from '@/hooks/useConversationViewPreference';
import { useConversationViewReadingCheckpoint } from '@/hooks/useConversationViewReadingCheckpoint';
import { useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { withQueuedInputPreviews } from '@/stores/queued-input-preview';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useThemeStore } from '@/stores/themeStore';
import { apiFetch } from '@/utils/api-client';
import { refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import { BUSY_THREAD, CURRENT_THREAD } from './f322-chat-real-page-data.mjs';
import { ActualProbe, themeApplied } from './f322-theme-applied';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

// This host owns only dimensions and the submission boundary. Sidebar, header,
// composer, theme, preferences, selection, drafts and apiFetch are production code.
primeCoCreatorConfigCache({
  name: 'Fixture Owner',
  aliases: [],
  mentionPatterns: ['@owner-proof'],
  color: { primary: '#6B5443', secondary: '#E9DCCF' },
});
useChatStore.setState({ currentThreadId: CURRENT_THREAD, currentProjectPath: '/wrong/global-workspace' });
syncDraftToStorage(BUSY_THREAD, '还没有发出去的补充意见');
void refreshSidebarThreadSnapshot();

const params = new URLSearchParams(location.search);
const sidebar = params.get('sidebar') !== '0';
const resizable = params.get('resizable') === '1';
if (resizable) useSidebarStore.getState().setWidth(300);
const surface = params.get('surface') === '1';
const messages: ChatMessageData[] = [
  {
    from: { kind: 'user', userId: 'owner-proof' },
    id: 'proof-user',
    type: 'user' as const,
    content: '这张封面可以。保留标题和猫猫的位置，再看看聊天区的输入操作。',
    timestamp: Date.now() - 180_000,
  },
  {
    from: { kind: 'agent', catId: 'codex-astra' },
    id: 'proof-cat',
    type: 'assistant' as const,
    catId: 'codex-astra',
    content: '我把它放回真实对话里了。先看标题、分组和草稿能不能一起读清，再试项目路径和首选猫。',
    timestamp: Date.now() - 120_000,
  },
];
const EMPTY_QUEUE = [] as const;

function ChatProof() {
  const presentation = useShellPresentation();
  const { width, handleResize } = useSidebarStore();
  const { getCatById } = useCatData();
  const threadMessages = useThreadMessages(CURRENT_THREAD);
  const queue = useChatStore((state) => scopedQueue(state, CURRENT_THREAD)) ?? EMPTY_QUEUE;
  const conversationMessages = useMemo(
    () => withQueuedInputPreviews(threadMessages, queue, CURRENT_THREAD),
    [queue, threadMessages],
  );
  const conversationViewController = useConversationViewPreference(CURRENT_THREAD, presentation === 'v2');
  const conversationViewReading = useConversationViewReadingCheckpoint({
    threadId: CURRENT_THREAD,
    controller: conversationViewController,
    messages: conversationMessages,
    queue,
  });
  const registerConversationReading = useCallback(
    (port: ChatReadingPort) => {
      conversationViewReading.setReadingPort(port);
      return () => conversationViewReading.setReadingPort(null);
    },
    [conversationViewReading.setReadingPort],
  );
  const ready = useSidebarProjectionStore((state) => state.hasCanonicalSnapshot);
  useEffect(() => {
    if (presentation === 'v2') document.documentElement.setAttribute('data-shell', 'v2');
    else document.documentElement.removeAttribute('data-shell');
  }, [presentation]);
  return (
    <div
      data-testid="chat-real-page"
      style={{
        display: 'flex',
        height: '100dvh',
        width: '100%',
        overflow: 'hidden',
        background: 'var(--cafe-surface-canvas)',
      }}
    >
      {sidebar && (
        <div style={{ width: resizable ? width : 300, flexShrink: 0, minWidth: 0, height: '100%' }}>
          <ThreadSidebar routeThreadId={CURRENT_THREAD} className="w-full h-full min-w-0" />
        </div>
      )}
      {sidebar && resizable && <ResizeHandle direction="horizontal" label="侧栏" onResize={handleResize} />}
      <main
        data-testid="chat-proof-pane"
        style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          flexDirection: 'column',
          background: 'var(--shell-work, var(--console-shell-bg))',
        }}
      >
        <ChatContainerHeader
          threadId={CURRENT_THREAD}
          sidebarOpen={sidebar}
          onToggleSidebar={() => undefined}
          viewMode="single"
          onToggleViewMode={() => undefined}
          statusPanelOpen={false}
          onToggleStatusPanel={() => undefined}
          conversationViewController={conversationViewController}
          conversationViewMessages={conversationMessages}
          conversationViewQueue={queue}
        />
        {surface ? (
          <ThreadChatRuntimeProvider routeThreadId={CURRENT_THREAD}>
            <ThreadChatSurface
              threadId={CURRENT_THREAD}
              density="full"
              conversationViewController={conversationViewController}
              conversationViewQueue={queue}
              onReadingPort={registerConversationReading}
            />
          </ThreadChatRuntimeProvider>
        ) : (
          <>
            <div
              data-testid="chat-proof-reading"
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                width: '100%',
                maxWidth: 752,
                padding: 16,
                alignSelf: 'center',
              }}
            >
              {messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  threadId={CURRENT_THREAD}
                  getCatById={getCatById}
                  onEditCat={() => undefined}
                />
              ))}
            </div>
            <div style={{ width: '100%', maxWidth: 752, alignSelf: 'center' }}>
              <ChatInput
                threadId={CURRENT_THREAD}
                presentation={presentation}
                composerContext={<ThreadComposerContext threadId={CURRENT_THREAD} />}
                onSend={async (content) => {
                  const response = await apiFetch('/api/messages', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ threadId: CURRENT_THREAD, content }),
                  });
                  return response.ok;
                }}
              />
            </div>
          </>
        )}
      </main>
      {ready && <span hidden data-testid="chat-proof-ready" />}
    </div>
  );
}

declare global {
  interface Window {
    __f322Chat: {
      language: typeof writeShellLanguage;
      presentation: typeof writeShellPresentation;
      theme: (base: 'light' | 'dark') => void;
      applied: typeof themeApplied;
      selectedThread: () => string;
      currentProject: () => string;
      incoming: (threadId: string, message: ChatMessageData) => void;
    };
  }
}
window.__f322Chat = {
  language: writeShellLanguage,
  presentation: writeShellPresentation,
  theme: (base) => useThemeStore.getState().setActive(base),
  applied: themeApplied,
  selectedThread: () => useChatStore.getState().currentThreadId,
  currentProject: () => useChatStore.getState().currentProjectPath,
  incoming: (threadId, message) => useChatStore.getState().addMessageToThread(threadId, message),
};
const root = document.getElementById('root');
if (!root) throw new Error('Missing chat proof root');
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <ActualProbe />
    <ChatProof />
  </ThemeProvider>,
);
