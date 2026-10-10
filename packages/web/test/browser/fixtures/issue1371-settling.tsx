import type { LifecycleActiveRun } from '@cat-cafe/shared';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/console-tokens.css';
import '@/app/globals.css';
import { ChatMessage } from '@/components/ChatMessage';
import { MessageDispatchAvatars } from '@/components/MessageDispatchAvatars';
import { QueuePanel } from '@/components/QueuePanel';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const threadId = 'settlement-browser';
const source: Message = {
  id: 'm',
  type: 'user',
  content: '审阅这条消息',
  timestamp: 1,
  lifecycle: {
    kind: 'input',
    orderKey: '1:m',
    dispatchRefs: [{ targetId: 'codex-astra', phase: 'dispatched', statusMessageId: 'r', dispatchedAt: 2 }],
  },
};
const response: Message = {
  id: 'r',
  type: 'assistant',
  catId: 'codex-astra',
  content: '',
  timestamp: 2,
  lifecycle: {
    kind: 'response',
    orderKey: '2:r',
    invocationId: 'primary',
    targetId: 'codex-astra',
    inputEntryIds: ['q'],
    inputMessageIds: ['m'],
    status: 'processing',
    startedAt: 2,
  },
};
const active: LifecycleActiveRun = {
  threadId,
  targetId: 'codex-astra',
  invocationId: 'primary',
  responseMessageId: 'r',
  inputEntryIds: ['q'],
  inputMessageIds: ['m'],
  privateInputEntryIds: [],
  startedAt: 2,
};
primeCoCreatorConfigCache({ name: 'owner', aliases: [], mentionPatterns: [] });
useChatStore.setState({
  currentThreadId: threadId,
  queue: [],
  activeInvocations: {},
  catInvocations: {},
  messages: [source, response],
});
function Proof() {
  const [mode, setMode] = useState('guard');
  const failed = mode === 'failed';
  const r: Message = failed
    ? {
        ...response,
        lifecycle:
          response.lifecycle?.kind === 'response'
            ? { ...response.lifecycle, status: 'failed', completedAt: 3 }
            : undefined,
        extra: { timeoutDiagnostics: { silenceDurationMs: 1846576, processAlive: true, invocationId: 'primary' } },
      }
    : response;
  const timeline = [source, r];
  const runs = mode === 'guard' ? [active] : mode === 'replacement' ? [{ ...active, invocationId: 'new-child' }] : [];
  return (
    <main data-ready="true" className="min-h-screen bg-cafe-surface-canvas p-6 text-cafe">
      <h1>一条投递，一个回复结果</h1>
      <div className="my-4 flex flex-wrap gap-4">
        <button onClick={() => setMode('guard')}>进入正常收尾</button>
        <button onClick={() => setMode('gone')}>原执行结束但无回执</button>
        <button onClick={() => setMode('replacement')}>同猫开始其他工作</button>
        <button onClick={() => setMode('failed')}>原回复超时</button>
      </div>
      <MessageDispatchAvatars
        message={source}
        timelineMessages={timeline}
        activeRuns={runs}
        getCatLabel={() => 'Astra'}
      />
      <ChatMessage message={r} threadId={threadId} timelineMessages={timeline} getCatById={() => undefined} />
      <QueuePanel threadId={threadId} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
