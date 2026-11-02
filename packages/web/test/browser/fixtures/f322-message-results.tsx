import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import { ChatMessage } from '@/components/ChatMessage';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { MessageSearchButton } from '@/components/message-search/MessageSearchButton';
import { MessageSearchOverlay } from '@/components/message-search/MessageSearchOverlay';
import { useMessageSearchHost } from '@/components/message-search/useMessageSearchHost';
import {
  getBrowserThreadRoutePathname,
  getThreadIdFromPathname,
  pushThreadRouteWithHistory,
  subscribeBrowserThreadRoute,
} from '@/components/ThreadSidebar/thread-navigation';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useThreadChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';

const proofNavigation = new URLSearchParams(window.location.search).has('proofNavigation');

function ControlledReadingSurface() {
  const withWorkspace = new URLSearchParams(window.location.search).has('proofWorkspace');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const desktop = window.matchMedia('(min-width: 768px)').matches;
  const available = !workspaceOpen || desktop;
  const { getCatById } = useCatData(); // The actual ChatContainer owns this registry subscription in the product.
  const pathname = useSyncExternalStore(subscribeBrowserThreadRoute, getBrowserThreadRoutePathname);
  const routeThread = getThreadIdFromPathname(pathname);
  const threadId = routeThread === 'default' ? 'recall-controlled' : routeThread;
  useLayoutEffect(() => useChatStore.getState().setCurrentThread(threadId), [threadId]);
  const longMessage = new URLSearchParams(window.location.search).has('proofLong');
  const history = useChatHistory(threadId);
  const messages = useThreadMessages(threadId);
  const host = useMessageSearchHost({
    threadId,
    available,
    pushThreadRoute: (next) => pushThreadRouteWithHistory(next, window),
  });
  useThreadChatReadingPort(threadId, 'conversation', available ? host.registerReadingPort : undefined, history);
  return (
    <div className="flex h-screen">
      <div
        className="relative mx-auto flex h-screen min-w-0 flex-1 flex-col bg-[var(--console-panel-bg)]"
        style={{ maxWidth: withWorkspace && workspaceOpen && desktop ? 400 : 720 }}
        data-testid="thread-chat-host"
        data-reading-trip-status={host.session?.trip.status}
      >
        <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[var(--console-border-soft)] px-4 text-sm text-cafe-black">
          <span>消息找回 · 受控组件验证</span>
          {proofNavigation && (
            <>
              <button onClick={() => pushThreadRouteWithHistory('remote-controlled', window)}>另一对话</button>
              <button
                onClick={() => {
                  const state = useChatStore.getState();
                  useChatStore.setState({
                    threadStates: {
                      ...state.threadStates,
                      'recall-controlled': { ...state.getThreadState('recall-controlled'), unreadCount: 2 },
                    },
                  });
                  pushThreadRouteWithHistory('recall-controlled', window);
                }}
              >
                未读缓存对话
              </button>
            </>
          )}
          <MessageSearchButton onOpen={host.openSearch} open={host.open} />
          {withWorkspace && (
            <button type="button" onClick={() => setWorkspaceOpen(true)}>
              查看原图
            </button>
          )}
        </header>
        <MessageSearchOverlay
          threadId={threadId}
          host={host}
          available={available}
          resolveSpeaker={(speaker) => (speaker === 'codex61-sol' ? '砚砚' : speaker === 'opus55' ? '宪宪' : speaker)}
        />
        <div className="relative min-h-0 flex-1">
          <div
            ref={history.scrollContainerRef}
            onScroll={history.handleScroll}
            data-reading-surface
            className="h-full overflow-auto px-6 py-4"
          >
            {messages.map((message) => (
              <MessageViewportBoundary key={message.id} messageId={message.id} eager>
                {longMessage && message.id === 'old-0' ? (
                  <ChatMessage message={message} getCatById={getCatById} threadId={threadId} />
                ) : (
                  <article data-message-id={message.id} className="min-h-[160px] py-6 text-sm text-cafe-secondary">
                    {message.content}
                  </article>
                )}
              </MessageViewportBoundary>
            ))}
            <div ref={history.messagesEndRef} />
          </div>
        </div>
        <footer className="shrink-0 border-t border-[var(--console-border-soft)] p-4 text-sm text-cafe-secondary">
          原阅读表面 · Host 控件在浮层
        </footer>
      </div>
      {workspaceOpen && (
        <section
          aria-label="作品查看器边界"
          className={
            desktop
              ? 'relative min-w-0 flex-1 bg-[var(--console-panel-bg)]'
              : 'fixed inset-0 z-50 bg-[var(--console-panel-bg)]'
          }
        >
          <header className="flex justify-end px-4" style={{ marginTop: 60 }}>
            <button type="button" onClick={() => setWorkspaceOpen(false)}>
              ‹ 聊天
            </button>
          </header>
        </section>
      )}
    </div>
  );
}
const mount = document.getElementById('root');
if (!mount) throw new Error('Missing controlled fixture mount');
createRoot(mount).render(
  <ThreadChatHistoryAdmissionProvider>
    <ControlledReadingSurface />
  </ThreadChatHistoryAdmissionProvider>,
);
