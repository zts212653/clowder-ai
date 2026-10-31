import { useState } from 'react';
import { ChatMessage } from '@/components/ChatMessage';
import { MessageActions } from '@/components/MessageActions';
import { MessageBundleCard } from '@/components/MessageBundleCard';
import { MessageSelectionToolbar } from '@/components/MessageSelectionToolbar';
import { useCatData } from '@/hooks/useCatData';
import type { ChatMessage as Message } from '@/stores/chat-types';

const source: Message = {
  from: { kind: 'agent', catId: 'opus' },
  id: 'c-source',
  type: 'assistant',
  catId: 'opus',
  timestamp: 1791210000000,
  content: 'A readable message with its actions owned by the author row.',
  extra: { crossPost: { sourceThreadId: 'c-original' } },
};
const retiredSource: Message = {
  ...source,
  id: 'c-retired-source',
  from: { kind: 'agent', catId: 'retired-source-cat' },
  catId: 'retired-source-cat',
};
const humanSource: Message = {
  ...source,
  id: 'c-user',
  from: { kind: 'user', userId: 'default-user' },
  type: 'user',
  catId: undefined,
  extra: undefined,
};

/** Controlled inputs through the real row/selection/card components; live acceptance is separate. */
export function ReadingActions() {
  const { getCatById } = useCatData();
  const [selected, setSelected] = useState(false);
  return (
    <section data-testid="line-c" className="mt-8 min-w-0">
      <MessageActions
        message={source}
        threadId="thread-replies"
        selectionEligible
        selected={selected}
        selectionMode={selected}
        onEnterSelection={() => setSelected(true)}
        onToggleSelection={() => setSelected(!selected)}
      >
        <ChatMessage message={source} threadId="thread-replies" getCatById={getCatById} onEditCat={() => undefined} />
      </MessageActions>
      <MessageActions message={retiredSource} threadId="thread-replies">
        <ChatMessage
          message={retiredSource}
          threadId="thread-replies"
          getCatById={getCatById}
          onEditCat={() => undefined}
        />
      </MessageActions>
      <MessageActions message={humanSource} threadId="thread-replies">
        <ChatMessage message={humanSource} threadId="thread-replies" getCatById={getCatById} />
      </MessageActions>
      {selected && (
        <MessageSelectionToolbar
          threadId="thread-replies"
          selectedMessageIds={[source.id]}
          forwardingDisabled
          onCancel={() => setSelected(false)}
          onExportSuccess={() => setSelected(false)}
          onForward={() => undefined}
        />
      )}
      <MessageBundleCard
        messageId="c-bundle"
        forwarderName="Fixture Owner"
        getCatLabel={(id) => getCatById(id)?.displayName ?? id}
      />
    </section>
  );
}
