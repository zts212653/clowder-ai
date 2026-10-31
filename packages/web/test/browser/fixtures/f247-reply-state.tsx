import { useEffect, useState } from 'react';
import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { SystemNoticeBar } from '@/components/SystemNoticeBar';
import { MessageNavigationProvider } from '@/components/thread-chat/MessageNavigationContext';
import { callbackPost } from '@/hooks/agent-messages/named-target';
import type { AgentEventFields } from '@/hooks/agent-messages/types';
import type { ChatMessage } from '@/stores/chat-types';

interface Journey {
  threadId: string;
  source: ChatMessage;
  notice: ChatMessage;
  placeholder: ChatMessage;
}

/** Isolated browser fixture; server-side callbacks and the owner lookup remain real. */
export function ReplyStateJourney() {
  const [journey, setJourney] = useState<Journey>();
  const [answer, setAnswer] = useState<ChatMessage>();
  const [focused, setFocused] = useState<string>();
  useEffect(() => {
    void fetch('/api/reply-journey')
      .then((response) => response.json())
      .then(setJourney);
    const onReturn = (event: Event) => {
      const wire = (event as CustomEvent<AgentEventFields & { timestamp?: number }>).detail;
      setAnswer(callbackPost(wire, wire.timestamp ?? Date.now()));
    };
    window.addEventListener('reply-journey-return', onReturn);
    return () => window.removeEventListener('reply-journey-return', onReturn);
  }, []);
  if (!journey) return <p>Loading isolated reply journey</p>;
  const messages = [journey.source, journey.placeholder, journey.notice, ...(answer ? [answer] : [])];
  return (
    <MessageNavigationProvider
      value={(id) => {
        setFocused(id);
        return true;
      }}
    >
      <main className="mx-auto max-w-3xl p-4">
        <h1 className="mb-4 text-lg font-semibold text-cafe">Pro 回信状态（隔离验证）</h1>
        <article data-message-id={journey.source.id} className="mb-4 rounded-xl border border-default p-4">
          <p>{journey.source.content}</p>
          <CloudBindingRecoveryCard
            threadId={journey.threadId}
            sourceMessageId={journey.source.id}
            targetCatId="gpt-pro"
            attemptId="inv"
            deliveryStatus="unknown"
            timelineMessages={messages}
          />
        </article>
        <SystemNoticeBar message={journey.notice} threadId={journey.threadId} timelineMessages={messages} />
        {answer ? (
          <article
            data-testid="actual-return"
            data-message-id={answer.id}
            className="rounded-xl border border-default p-4"
          >
            {answer.content}
          </article>
        ) : null}
        {focused ? <output data-testid="reply-navigation">{focused}</output> : null}
      </main>
    </MessageNavigationProvider>
  );
}
