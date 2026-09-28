'use client';

import { useEffect, useState } from 'react';
import { CloudBindingRecoveryCard, CloudBindingRecoveryCardView } from '@/components/CloudBindingRecoveryCard';
import type { RecoveryPhase } from '@/components/cloud-binding-recovery-operations';

const candidates = [
  {
    conversationId: 'conversation-stars',
    chatUrl: 'https://chatgpt.com/c/conversation-stars',
    displayTitle: '把云端的小星星接回家',
    authorizedAt: '2026-09-05T06:26:00.000Z',
    updatedAt: '2026-09-05T06:26:00.000Z',
  },
  {
    conversationId: 'conversation-design',
    chatUrl: 'https://chatgpt.com/c/conversation-design',
    displayTitle: 'Clowder AI · 一起看会话连接体验',
    authorizedAt: '2026-09-04T04:56:00.000Z',
    updatedAt: '2026-09-04T04:56:00.000Z',
  },
  {
    conversationId: 'conversation-legacy',
    chatUrl: 'https://chatgpt.com/c/conversation-legacy',
    authorizedAt: '2026-08-29T07:42:00.000Z',
    updatedAt: '2026-08-29T07:42:00.000Z',
  },
];
const scenarios = ['选择会话', '只有一个会话', '尚未授权', '仅连接旧消息', '发送中', '已送达', '状态未知'] as const;
type Scenario = (typeof scenarios)[number];

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  const [selected, setSelected] = useState<string | null>(
    scenario === '选择会话' ? null : candidates[0].conversationId,
  );
  const [bound, setBound] = useState<string | null>(
    ['发送中', '已送达', '状态未知'].includes(scenario) ? candidates[0].conversationId : null,
  );
  const [phase, setPhase] = useState<RecoveryPhase>(scenario === '发送中' ? 'queued' : 'idle');
  const [showChoices, setShowChoices] = useState(scenario === '选择会话');
  const connectionOnly = scenario === '仅连接旧消息' || scenario === '状态未知';
  return (
    <CloudBindingRecoveryCardView
      threadId="thread-preview"
      sourceMessageId="source-preview"
      targetCatId="gpt-pro"
      attemptId={connectionOnly ? undefined : 'attempt-current'}
      deliveryStatus={scenario === '已送达' ? 'sent' : scenario === '状态未知' ? 'unknown' : undefined}
      loadState={{
        kind: 'ready',
        candidates: scenario === '尚未授权' ? [] : scenario === '只有一个会话' ? [candidates[0]] : candidates,
        boundConversationId: bound,
        retryState: connectionOnly ? 'unavailable' : 'ready',
        ...(connectionOnly ? { retryStateError: '无法确认这条旧消息的发送状态。连接会话不会重发它。' } : {}),
      }}
      selectedConversationId={selected}
      showChoices={showChoices}
      phase={phase}
      operationError={null}
      onSelect={setSelected}
      onToggleChoices={() => setShowChoices((value) => !value)}
      onRefresh={() => setShowChoices(true)}
      onSubmit={() => {
        setBound(selected);
        setPhase(connectionOnly ? 'connected' : 'queued');
        setShowChoices(false);
      }}
    />
  );
}

export default function F247InlineRecoveryPreview() {
  const [scenario, setScenario] = useState<Scenario>('选择会话');
  const [controller, setController] = useState(false);
  useEffect(() => {
    setController(new URLSearchParams(window.location.search).get('controller') === '1');
  }, []);
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-5 bg-cafe-bg p-4 sm:p-8">
      <header>
        <p className="text-xs font-semibold text-cafe-muted">F247 · 设计预览 · 示例数据</p>
        <h1 className="mt-2 text-xl font-bold text-cafe">让砚砚 Pro 回到当前对话</h1>
      </header>
      {!controller ? (
        <nav aria-label="预览状态" className="flex flex-wrap gap-2">
          {scenarios.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={value === scenario}
              onClick={() => setScenario(value)}
              className="rounded-lg border border-[var(--console-border-soft)] px-3 py-2 text-xs text-cafe aria-pressed:bg-[var(--console-hover-bg)]"
            >
              {value}
            </button>
          ))}
        </nav>
      ) : null}
      <div className="rounded-2xl rounded-br-md bg-[var(--color-cocreator-surface)] px-4 py-4 text-[var(--color-cocreator-text)]">
        <p className="text-sm">
          <span className="font-semibold text-blue-600">@gpt-pro</span> 嘿嘿，回来一起聊聊～
        </p>
        {controller ? (
          <CloudBindingRecoveryCard
            threadId="thread-preview"
            sourceMessageId="source-preview"
            targetCatId="gpt-pro"
            attemptId="attempt-stale"
          />
        ) : (
          <ScenarioCard key={scenario} scenario={scenario} />
        )}
      </div>
    </main>
  );
}
