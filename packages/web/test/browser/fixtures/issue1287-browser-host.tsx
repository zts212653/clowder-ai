import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessage } from '@/components/ChatMessage';
import { ThreadChatRuntimeProvider, useThreadChatRuntime } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';

const params = new URLSearchParams(location.search);
const target = params.get('target') ?? 'target';
const other = target + '-other';
const initial = params.get('pane') === 'other' ? other : target;
useChatStore.setState({ currentThreadId: initial });

function Pane({ id }: { id: string }) {
  const { socketConnected } = useThreadChatRuntime([id]);
  const { getCatById } = useCatData({ fetch: false });
  const { messages, scrollContainerRef, messagesEndRef } = useChatHistory(id);
  return (
    <main data-connected={String(socketConnected)} data-thread={id} style={{ width: 850, margin: '16px auto' }}>
      <h1 style={{ fontSize: 20, fontWeight: 650, padding: '12px 0' }}>{id === target ? '会话 A' : '会话 B'}</h1>
      <div ref={scrollContainerRef} style={{ height: 680, overflow: 'auto' }}>
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            threadId={id}
            timelineMessages={messages}
            getCatById={getCatById}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
    </main>
  );
}

function Probe() {
  const [id, setId] = useState(initial);
  useLayoutEffect(() => {
    useChatStore.getState().setCurrentThread(id);
  }, [id]);
  return (
    <ThreadChatRuntimeProvider routeThreadId={id}>
      <nav style={{ display: 'flex', gap: 8, padding: '8px 16px' }}>
        <button
          aria-label="Target"
          aria-pressed={id === target}
          style={{ padding: '6px 16px', border: '1px solid #888', background: id === target ? '#d9e5ff' : '#fff' }}
          onClick={() => setId(target)}
        >
          会话 A
        </button>
        <button
          aria-label="Other"
          aria-pressed={id === other}
          style={{ padding: '6px 16px', border: '1px solid #888', background: id === other ? '#d9e5ff' : '#fff' }}
          onClick={() => setId(other)}
        >
          会话 B
        </button>
      </nav>
      <Pane id={id} />
    </ThreadChatRuntimeProvider>
  );
}
Object.assign(window, {
  proofState: (id: string) => {
    const s = useChatStore.getState();
    const t = s.getThreadState(id);
    return {
      messages: t.messages,
      unread: t.unreadCount,
      active: t.hasActiveInvocation,
      seq: s.lastSeqByThread[id],
      requested: s.streamCatchUpVersionByThread[id],
      consumed: s.lastConsumedCatchUpVersionByThread[id],
    };
  },
  proofSend: async (threadId: string, content: string) => {
    const result = await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, content, mentions: ['opus'] }),
    });
    return { status: result.status, payload: await result.json() };
  },
});
createRoot(document.getElementById('root')!).render(<Probe />);
