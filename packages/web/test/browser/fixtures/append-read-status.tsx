import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/globals.css';
import { AppendedInputReceipts } from '@/components/AppendedInputReceipts';
import { MessageDispatchAvatars } from '@/components/MessageDispatchAvatars';
import { reconcileThreadWithServer } from '@/hooks/queue-reconciliation';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

primeCoCreatorConfigCache({ name: 'lang', aliases: [], mentionPatterns: [] });
const source = (id: string, supported: boolean): ChatMessage => ({
  id,
  type: 'user',
  from: { kind: 'user', userId: 'owner' },
  content: '请保留这个消息的准确归属，并继续原任务。',
  timestamp: 20,
  lifecycle: {
    kind: 'input',
    orderKey: `20:${id}`,
    dispatchRefs: [
      {
        targetId: 'opus',
        statusMessageId: 'r',
        phase: 'dispatched',
        dispatchedAt: 21,
        ...(supported ? { inputRead: { status: 'pending' as const } } : {}),
      },
    ],
  },
});
function Proof() {
  const [mode, setMode] = useState(() => sessionStorage.getItem('append-proof-mode') ?? 'pending');
  const queue = useChatStore((state) => state.queue);
  useEffect(() => {
    sessionStorage.setItem('append-proof-mode', mode);
    const entry: QueueEntry = {
      id: 'q1',
      threadId: 'thread',
      userId: 'owner',
      messageId: 'supported',
      content: '原消息',
      mergedMessageIds: [],
      from: { kind: 'user', userId: 'owner' },
      targetCats: ['opus'],
      status: 'queued',
      createdAt: 20,
      autoExecute: true,
      intent: 'execute',
      priority: 'normal',
      ...(mode.startsWith('unknown') && mode !== 'unknown-checking'
        ? {
            recoveryActions: [
              {
                id: 'repeat:q1:opus',
                entryId: 'q1',
                kind: 'repeat_target',
                targetCatId: 'opus',
                request: { method: 'POST', path: '/api/threads/thread/messages/supported/routing-targets/opus/repeat' },
              },
            ],
          }
        : {}),
    };
    useChatStore.setState({
      currentThreadId: 'thread',
      queue: mode.startsWith('unknown') || mode.startsWith('queued') ? [entry] : [],
    });
    if (mode.startsWith('unknown')) void reconcileThreadWithServer('thread', () => false, 'AppendProofReload');
  }, [mode]);
  const additional = mode === 'many' ? [1, 2, 3].map((index) => source(`extra-${index}`, false)) : [];
  const pending = source('supported', true);
  if (mode.startsWith('unknown') && pending.lifecycle)
    pending.lifecycle = {
      ...pending.lifecycle,
      appendFailures: [
        {
          targetId: 'opus',
          invocationId: 'inv',
          responseMessageId: 'r',
          acceptance: 'unknown',
          reason: 'exception',
          at: 22,
          ...(mode !== 'unknown-checking' ? { checkedAt: 23 } : {}),
        },
      ],
    };
  if (mode.startsWith('queued') && pending.lifecycle) pending.lifecycle = { ...pending.lifecycle, dispatchRefs: [] };
  if ((mode === 'read' || mode === 'unknown-read') && pending.lifecycle?.dispatchRefs)
    pending.lifecycle = {
      ...pending.lifecycle,
      dispatchRefs: pending.lifecycle.dispatchRefs.map((ref) => ({
        ...ref,
        inputRead: { status: 'read' as const, at: 22 },
      })),
    };
  const activeRun = {
    threadId: 'thread',
    targetId: 'opus',
    invocationId: 'inv',
    responseMessageId: 'r',
    inputEntryIds: ['q1'],
    inputMessageIds: mode.startsWith('queued') ? ['initial'] : ['supported'],
    privateInputEntryIds: [],
    startedAt: 10,
  };
  const response: ChatMessage = {
    id: 'r',
    type: 'assistant',
    catId: 'opus',
    from: { kind: 'agent', catId: 'opus' },
    content: '正在处理原任务。',
    timestamp: 10,
    lifecycle: {
      kind: 'response',
      orderKey: '10:r',
      invocationId: 'inv',
      targetId: 'opus',
      inputEntryIds: ['q0', 'q1', 'q2'],
      inputMessageIds: [
        'initial',
        ...(mode.startsWith('queued') ? [] : ['supported']),
        'unsupported',
        ...additional.map((message) => message.id),
      ],
      status: mode === 'terminal' ? 'interrupted' : 'processing',
      startedAt: 10,
    },
  };
  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-4 text-cafe" data-ready="true">
      <article className="max-w-xl rounded-lg border border-cafe p-3">
        <p>正在处理原任务。</p>
        <AppendedInputReceipts
          key={mode === 'many' ? 'many' : 'read-status'}
          response={response}
          timelineMessages={[pending, source('unsupported', false), ...additional]}
          getCatById={() => undefined}
        />
      </article>
      {mode.startsWith('unknown') || mode.startsWith('queued') ? (
        <article className="mt-4 max-w-xl rounded-lg border border-cafe p-3" aria-label="原消息收件进度">
          <p>{pending.content}</p>
          <MessageDispatchAvatars
            message={pending}
            timelineMessages={[response]}
            activeRuns={mode === 'queued-idle' ? [] : [activeRun]}
            queue={queue}
            getCatLabel={() => '砚砚'}
            inline
          />
        </article>
      ) : null}
      {queue
        .filter((entry) => entry.messageId !== 'supported')
        .map((entry) => {
          const repeated = source(entry.messageId!, true);
          repeated.content = entry.content;
          repeated.lifecycle = { ...repeated.lifecycle!, dispatchRefs: [] };
          return (
            <article
              key={entry.id}
              className="mt-4 max-w-xl rounded-lg border border-cafe p-3"
              aria-label="再次发送的新消息"
            >
              <p>{repeated.content}</p>
              <MessageDispatchAvatars
                message={repeated}
                timelineMessages={[pending, response]}
                activeRuns={mode === 'queued-idle' ? [] : [activeRun]}
                queue={queue}
                getCatLabel={() => '砚砚'}
                inline
              />
            </article>
          );
        })}
      <div className="mt-8 flex flex-wrap gap-3" role="group" aria-label="测试时序控制">
        {[
          'pending',
          'read',
          'terminal',
          'many',
          'unknown-checking',
          'unknown',
          'unknown-read',
          'queued',
          'queued-idle',
        ].map((value) => (
          <button key={value} onClick={() => setMode(value)}>
            {value}
          </button>
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
