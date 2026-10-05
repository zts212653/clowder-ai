import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { ThreadChatRuntimeProvider, useThreadChatRuntime } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

import { NavigationOwnerProof } from './chat-navigation-owner';

const threadId = 'chat-recovery';
useChatStore.setState({
  currentThreadId: threadId,
  threads: [
    {
      id: threadId,
      title: 'Connection recovery',
      projectPath: '/fixture',
      createdAt: 1,
      createdBy: 'fixture-owner',
      participants: [],
      lastActiveAt: 1,
    },
  ],
});

function Conversation() {
  const { socketConnected } = useThreadChatRuntime([threadId]);
  const { scrollContainerRef, messagesEndRef } = useChatHistory(threadId);
  useActiveExecutionProjection(threadId, socketConnected);
  const messages = useChatStore((state) => state.messages);
  const executions = useActiveExecutionStore((state) => state.executionsByKey);
  return (
    <main data-connected={String(socketConnected)}>
      <h1>Chat recovery browser proof</h1>
      <output data-executions>
        {Object.values(executions)
          .map((entry) => entry.catId)
          .join(', ')}
      </output>
      <div ref={scrollContainerRef}>
        {messages.map((message) => (
          <article key={message.id} data-message-id={message.id}>
            {message.content}
          </article>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </main>
  );
}

// Shares the real history/admission owner and deferred-message boundary. The
// parent sync deliberately occurs after the scoped child projects the new DOM,
// matching ChatContainer -> ThreadChatSurface navigation ordering.
function ScrollConversation({ activeThread }: { activeThread: string }) {
  const { scrollContainerRef, messagesEndRef, handleScroll, jumpToLatest } = useChatHistory(activeThread);
  const messages = useThreadMessages(activeThread);
  return (
    <>
      <button type="button" onClick={jumpToLatest}>
        Latest
      </button>
      <button
        type="button"
        onClick={() => {
          useChatStore.getState().replaceThreadMessageId(activeThread, 'scroll-5', 'settled-reading');
          useChatStore.getState().patchThreadMessage(activeThread, 'settled-reading', { isStreaming: false });
        }}
      >
        Finalize reading message
      </button>
      <button type="button" onClick={() => useChatStore.getState().removeThreadMessage(activeThread, 'scroll-55')}>
        Delete reading message
      </button>
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        data-scroll-chat
        style={{ height: 600, overflowY: 'auto', overflowAnchor: 'auto' }}
      >
        {messages.map((message, index) => (
          <MessageViewportBoundary
            key={message.id}
            messageId={message.id}
            eager={index >= messages.length - 4}
            backgroundMountDelayMs={50 + index * 5}
          >
            <article data-message-id={message.id} style={{ minHeight: 160, padding: 16 }}>
              {message.content}
            </article>
          </MessageViewportBoundary>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </>
  );
}
function ScrollProof() {
  const [activeThread, setActiveThread] = useState(() => location.pathname.slice(1) || threadId);
  useEffect(() => {
    const back = () => setActiveThread(location.pathname.slice(1) || threadId);
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    useChatStore.getState().setCurrentThread(activeThread);
  }, [activeThread]);
  const navigate = (id: string) => {
    history.pushState({}, '', `/${id}?scroll=1`);
    setActiveThread(id);
  };
  return (
    <ThreadChatRuntimeProvider routeThreadId={activeThread}>
      <button type="button" onClick={() => navigate('chat-other')}>
        Other thread
      </button>
      <ScrollConversation activeThread={activeThread} />
    </ThreadChatRuntimeProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing browser fixture root');
createRoot(root).render(
  new URLSearchParams(location.search).has('navigation') ? (
    <NavigationOwnerProof />
  ) : new URLSearchParams(location.search).has('scroll') ? (
    <ScrollProof />
  ) : (
    <ThreadChatRuntimeProvider routeThreadId={threadId}>
      <Conversation />
    </ThreadChatRuntimeProvider>
  ),
);
