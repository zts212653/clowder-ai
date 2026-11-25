import { createRoot } from 'react-dom/client';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';

// A test host for the production socket/agent-message hooks. No provider is invoked.
useChatStore.setState({ currentThreadId: 'gap-thread', messages: [], threadStates: {} });

function Host() {
  const threadId = useChatStore((state) => state.currentThreadId);
  if (!threadId) throw new Error('The fixture requires a foreground thread');
  const messages = useChatStore((state) => state.messages);
  const { handleAgentMessage } = useAgentMessages();
  const { socketConnected } = useSocket(
    { onMessage: handleAgentMessage },
    threadId,
    [threadId],
    (source) => source === 'chat.messages',
  );
  return (
    <main data-connected={String(socketConnected)} data-thread={threadId}>
      <button type="button" onClick={() => useChatStore.getState().setCurrentThread('other-thread')}>
        Other thread
      </button>
      <button type="button" onClick={() => useChatStore.getState().setCurrentThread('gap-thread')}>
        Return
      </button>
      {messages.map((message) => (
        <pre key={message.id} data-message-id={message.id} data-prefix={message.streamPrefix}>
          {message.content}
        </pre>
      ))}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The fixture root is missing');
createRoot(root).render(<Host />);
