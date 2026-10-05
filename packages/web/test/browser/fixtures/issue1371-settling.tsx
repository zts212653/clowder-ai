import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';
import { MessageReceiptDock } from '@/components/MessageReceiptDock';
import { QueuePanel } from '@/components/QueuePanel';
import { collectExactLiveInvocationIds, collectSettlingInvocationIds } from '@/components/queue-receipt-projection';
import { hydrateQueueActiveInvocationSlots } from '@/hooks/queue-active-invocation-hydration';
import { normalizeQueueMessageReceiptProjections } from '@/hooks/queue-message-receipt-normalizer';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const threadId = 'settlement-browser';
const agyReceipt = normalizeQueueMessageReceiptProjections([
  {
    messageId: 'agy-source',
    queueReceipt: {
      version: 1,
      entryId: 'agy-entry',
      reminderAttempts: [],
      targets: [
        {
          catId: 'gemini38',
          state: 'queued',
          authorIntent: {
            requested: 'next_work',
            effective: 'next_work',
            carrierCapability: {
              provider: 'google',
              carrier: 'agy_stream_json',
              deliverySemantics: 'queued_internal_turn',
            },
          },
        },
      ],
    },
  },
])[0]?.queueReceipt;
const entry: QueueEntry = {
  id: 'q',
  threadId,
  userId: 'preview-owner',
  messageId: 'm',
  mergedMessageIds: [],
  content: '已完成的审阅消息',
  source: 'agent',
  sourceCategory: 'a2a',
  targetCats: ['codex-astra'],
  targetStates: { 'codex-astra': 'seen' },
  intent: 'execute',
  status: 'queued',
  createdAt: 1,
  queueReceipt: {
    version: 1,
    entryId: 'q',
    targets: [{ catId: 'codex-astra', state: 'seen', invocationId: 'primary', seenAt: 1 }],
    reminderAttempts: [],
  },
};
useChatStore.setState({
  currentThreadId: threadId,
  queue: [entry],
  queuePaused: false,
  activeInvocations: {},
  catInvocations: {},
  messages: [],
});

function frame(mode: 'guard' | 'gone' | 'replacement') {
  if (mode === 'gone') {
    useChatStore.getState().clearThreadActiveInvocation(threadId);
    return;
  }
  hydrateQueueActiveInvocationSlots({
    threadId,
    slots: [
      {
        catId: 'codex-astra',
        startedAt: 1,
        executionId: mode === 'guard' ? 'parent' : 'new-parent',
        turnInvocationId: mode === 'guard' ? 'guard' : 'new-child',
        ...(mode === 'guard'
          ? { settlement: { activeTurnInvocationId: 'guard', completedTurnInvocationIds: ['primary'] } }
          : {}),
      },
    ],
  });
}

function Proof() {
  const active = useChatStore((s) => s.activeInvocations);
  const cats = useChatStore((s) => s.catInvocations);
  return (
    <main data-ready="true" className="min-h-screen bg-cafe-surface-canvas p-6 text-cafe">
      <h1>同一条消息的收尾与恢复</h1>
      <div className="my-4 flex flex-wrap gap-4">
        <button onClick={() => frame('guard')}>进入正常收尾</button>
        <button onClick={() => frame('gone')}>原执行结束但无回执</button>
        <button onClick={() => frame('replacement')}>同猫开始其他工作</button>
      </div>
      <MessageReceiptDock
        messageId="m"
        receipt={entry.queueReceipt!}
        messages={[]}
        getCatLabel={() => 'Astra'}
        activeInvocationIds={collectExactLiveInvocationIds(active, cats)}
        settlingInvocationIds={collectSettlingInvocationIds(active, cats)}
      />
      <section aria-label="AGY 排队回执">
        <MessageReceiptDock messageId="agy-source" receipt={agyReceipt} messages={[]} getCatLabel={() => '烁烁'} />
      </section>
      <QueuePanel threadId={threadId} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
