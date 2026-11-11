import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InteractiveBlock } from '@/components/rich/InteractiveBlock';
import { type InteractiveSendDetail } from '@/components/rich/interactive-block-client';
import { applyResponseStreamReplay, type StreamReplay } from '@/hooks/response-stream-replay';
import { mergeReplaceHydrationMessages } from '@/hooks/useChatHistory';
import { useSendMessage } from '@/hooks/useSendMessage';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

function Fixture() {
  const [threadId, setThreadId] = useState('question-thread');
  const messages = useChatStore((state) => state.messages);
  const { handleSend } = useSendMessage(threadId);
  const open = async (target: string) => {
    const result = await apiFetch(`/api/messages?threadId=${target}`);
    const history = (await result.json()) as { messages: ChatMessage[] };
    const state = useChatStore.getState();
    const merged = mergeReplaceHydrationMessages(history.messages, state.getThreadState(target).messages);
    state.replaceThreadMessages(target, merged.messages);
    state.setCurrentThread(target);
    const replay = (await (await apiFetch(`/api/fixture-replay?threadId=${target}`)).json()) as StreamReplay;
    applyResponseStreamReplay(replay);
    setThreadId(target);
  };
  useEffect(() => {
    void open('question-thread');
  }, []);
  useEffect(() => {
    const send = (event: Event) => {
      const detail = (event as CustomEvent<InteractiveSendDetail>).detail;
      if (detail.sendContext !== threadId || !detail.text) return;
      void handleSend(detail.text).then((sent) => detail.onResult?.(sent));
    };
    window.addEventListener('cat-cafe:interactive-send', send);
    return () => window.removeEventListener('cat-cafe:interactive-send', send);
  }, [threadId, handleSend]);
  return (
    <main>
      <nav>
        <button type="button" onClick={() => void open('question-thread')}>
          会话 A
        </button>
        <button type="button" onClick={() => void open('other-thread')}>
          会话 B
        </button>
      </nav>
      <p data-testid="active-thread">{threadId}</p>
      {messages.map((message) => (
        <article key={message.id}>
          <p>{message.content}</p>
          <p data-testid="response-status">{message.lifecycle?.kind === 'response' ? message.lifecycle.status : ''}</p>
          {message.extra?.rich?.blocks
            .filter((block) => block.kind === 'interactive')
            .map((block) => (
              <InteractiveBlock key={block.id} block={block} messageId={message.id} sendContext={threadId} />
            ))}
        </article>
      ))}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Browser fixture root is missing');
createRoot(root).render(<Fixture />);
