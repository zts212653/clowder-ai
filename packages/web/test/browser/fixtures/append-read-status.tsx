import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/globals.css';
import { AppendedInputReceipts } from '@/components/AppendedInputReceipts';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage } from '@/stores/chat-types';

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
  const [mode, setMode] = useState('pending');
  const pending = source('supported', true);
  if (mode === 'read' && pending.lifecycle?.dispatchRefs)
    pending.lifecycle = {
      ...pending.lifecycle,
      dispatchRefs: pending.lifecycle.dispatchRefs.map((ref) => ({
        ...ref,
        inputRead: { status: 'read' as const, at: 22 },
      })),
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
      inputMessageIds: ['initial', 'supported', 'unsupported'],
      status: mode === 'terminal' ? 'interrupted' : 'processing',
      startedAt: 10,
    },
  };
  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-4 text-cafe" data-ready="true">
      <article className="max-w-xl rounded-lg border border-cafe p-3">
        <p>正在处理原任务。</p>
        <AppendedInputReceipts
          response={response}
          timelineMessages={[pending, source('unsupported', false)]}
          getCatById={() => undefined}
        />
      </article>
      <div className="mt-8 flex gap-3" role="group" aria-label="测试时序控制">
        {['pending', 'read', 'terminal'].map((value) => (
          <button key={value} onClick={() => setMode(value)}>
            {value}
          </button>
        ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
