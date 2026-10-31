import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { ThreadChatRuntimeProvider, useThreadChatRuntime } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useChatHistory } from '@/hooks/useChatHistory';
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
  const { scrollContainerRef, messagesEndRef, handleScroll, jumpToLatest, messages } = useChatHistory(activeThread);
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('revalidateAtScroll')) return;
    const viewport = scrollContainerRef.current;
    let armed = false;
    let count = 0;
    const arm = (event: WheelEvent) => {
      if (event.isTrusted && event.deltaY < 0) armed = true;
    };
    const revalidate = (event: Event) => {
      if (!armed || event.target !== viewport || !viewport) return;
      armed = false;
      // Native pixels have moved, but React has not recorded the scroll yet.
      // Commit an ordinary same-height transport update at that boundary.
      flushSync(() => {
        useChatStore.getState().patchThreadMessage(activeThread, 'scroll-80', {
          content: `Streaming update ${++count}`,
        });
      });
      viewport.dataset.revalidationCount = String(count);
    };
    viewport?.addEventListener('wheel', arm);
    window.addEventListener('scroll', revalidate, true);
    return () => {
      viewport?.removeEventListener('wheel', arm);
      window.removeEventListener('scroll', revalidate, true);
    };
  }, [activeThread, scrollContainerRef]);
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('streamAtWheel')) return;
    const viewport = scrollContainerRef.current;
    // A deterministic transport scheduling boundary: a provider update commits
    // after trusted wheel input but before the browser dispatches its scroll.
    // The history owner, store writer, DOM layout and wheel default action are real.
    const stream = () => {
      flushSync(() => {
        useChatStore.getState().patchThreadMessage(activeThread, 'scroll-80', {
          content: 'Streaming paragraph grows while the reader starts moving upward. '.repeat(240),
        });
      });
    };
    viewport?.addEventListener('wheel', stream, { once: true });
    return () => viewport?.removeEventListener('wheel', stream);
  }, [activeThread, scrollContainerRef]);
  return (
    <>
      <button type="button" onClick={jumpToLatest}>
        Latest
      </button>
      <button
        type="button"
        onClick={() => {
          useChatStore.getState().patchThreadMessage(activeThread, 'scroll-80', {
            content: 'A passive update after the reader stopped scrolling.',
          });
        }}
      >
        Passive update
      </button>
      <button
        type="button"
        onClick={() => {
          useChatStore.getState().patchThreadMessage(activeThread, 'scroll-5', { isStreaming: false });
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
        style={{ height: 600, overflowY: 'auto', overflowAnchor: 'none' }}
      >
        <div data-thread-chat-reading-column>
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
