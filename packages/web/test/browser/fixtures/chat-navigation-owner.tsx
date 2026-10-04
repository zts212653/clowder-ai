import { useEffect, useState } from 'react';
import { MessageNavigator } from '@/components/MessageNavigator';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';

function NavigationConversation({ threadId }: { threadId: string }) {
  const { scrollContainerRef, messagesEndRef, handleScroll, jumpToMessage, beginUserScroll } = useChatHistory(threadId);
  const messages = useThreadMessages(threadId);
  return (
    <section data-navigation-proof style={{ position: 'relative', width: 600, height: 600 }}>
      <div ref={scrollContainerRef} onScroll={handleScroll} data-scroll-chat style={{ height: 600, overflowY: 'auto' }}>
        {messages.map((message) => (
          <MessageViewportBoundary key={message.id} messageId={message.id} eager>
            <article
              data-message-id={message.id}
              style={{ minHeight: message.id.endsWith('4') ? 460 : 160, padding: 16 }}
            >
              {message.content}
            </article>
          </MessageViewportBoundary>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div data-navigation-control>
        <MessageNavigator
          messages={messages}
          scrollContainerRef={scrollContainerRef}
          onJumpToMessage={jumpToMessage}
          beginUserScroll={beginUserScroll}
        />
      </div>
    </section>
  );
}

export function NavigationOwnerProof() {
  const [threadId, setThreadId] = useState(() => location.pathname.slice(1) || 'chat-recovery');
  useEffect(() => {
    const back = () => setThreadId(location.pathname.slice(1) || 'chat-recovery');
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    useChatStore.getState().setCurrentThread(threadId);
  }, [threadId]);
  return (
    <ThreadChatHistoryAdmissionProvider>
      <button
        type="button"
        onClick={() => {
          history.pushState({}, '', '/chat-other?navigation=1');
          setThreadId('chat-other');
        }}
      >
        Other thread
      </button>
      <NavigationConversation threadId={threadId} />
    </ThreadChatHistoryAdmissionProvider>
  );
}
