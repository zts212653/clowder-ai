import { createRoot } from 'react-dom/client';
import { ThreadChatRuntimeProvider, useThreadChatRuntime } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

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

const root = document.getElementById('root');
if (!root) throw new Error('Missing browser fixture root');
createRoot(root).render(
  <ThreadChatRuntimeProvider routeThreadId={threadId}>
    <Conversation />
  </ThreadChatRuntimeProvider>,
);
