'use client';

import { useEffect, useState } from 'react';
import type { CardConfirmationEntry } from '@/components/rich/CardBlock';
import { ThreadChatSurface } from '@/components/thread-chat';
import { type ChatMessage, DEFAULT_THREAD_STATE, type Thread, useChatStore } from '@/stores/chatStore';

const THREAD_ID = 'f229-chat-surface-parity';

const messages: ChatMessage[] = [
  {
    id: 'f229-user',
    type: 'user',
    content: '帮我找回之前讨论的认证问题。',
    timestamp: 1_787_995_000_001,
  },
  {
    id: 'f229-auth-error',
    type: 'system',
    variant: 'error',
    content: '首次调用未通过认证；诊断仍保留在真实时间线中。',
    timestamp: 1_787_995_000_002,
  },
  {
    id: 'f229-connector',
    type: 'connector',
    content: '连接器诊断：callback token 已过期，请重新授权。',
    source: { connector: 'vote-result', label: '连接器诊断', icon: 'ballot' },
    timestamp: 1_787_995_000_003,
  },
  {
    id: 'f229-assistant-rich',
    type: 'assistant',
    catId: 'codex-sol',
    content: '我保留了失败上下文，也找到了对应讨论。',
    metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
    extra: {
      isExplicitPost: true,
      rich: {
        v: 1,
        blocks: [
          {
            id: 'f229-result-card',
            kind: 'card',
            v: 1,
            title: '认证问题讨论',
            bodyMarkdown: 'full 与 compact 都渲染同一张 typed action card。',
            actions: [
              {
                label: '确认进入认证问题讨论',
                action: 'concierge_triage_confirm',
                payload: { planId: 'f229-parity-plan', intent: 'go', threadId: 'thread_f229_auth' },
              },
            ],
          },
        ],
      },
    },
    timestamp: 1_787_995_000_004,
  },
  {
    id: 'f229-cli',
    type: 'assistant',
    catId: 'codex-sol',
    origin: 'stream',
    content:
      'pnpm --filter @cat-cafe/web test -- --runInBand\n' +
      '这是用于验证 compact 宽度下 CLI diagnostics 不会撑破面板的长输出：'.repeat(6),
    metadata: { provider: 'openai', model: 'gpt-5.6-sol' },
    extra: { stream: { invocationId: 'f229-cli-invocation', turnInvocationId: 'f229-cli-turn' } },
    timestamp: 1_787_995_000_005,
  },
];

const messageConfirmations = new Map<string, CardConfirmationEntry[]>([
  [
    'f229-assistant-rich',
    [
      {
        id: 'f229-confirmation',
        messageId: 'f229-assistant-rich',
        status: 'confirmed',
        action: { kind: 'concierge_triage_confirm', planId: 'f229-parity-plan', intent: 'go' },
      },
    ],
  ],
]);

const thread: Thread = {
  id: THREAD_ID,
  title: 'F229 density parity',
  projectPath: '/fixture/f229-chat-surface-parity',
  createdBy: 'fixture',
  participants: ['codex-sol'],
  createdAt: 1_787_995_000_000,
  lastActiveAt: 1_787_995_000_005,
  bubbleCli: 'expanded',
};

function seedFixture(): void {
  const threadState = { ...DEFAULT_THREAD_STATE, messages, hasMore: false };
  useChatStore.setState({
    ...threadState,
    currentThreadId: THREAD_ID,
    threads: [thread],
    threadStates: { [THREAD_ID]: threadState },
  });
}

export default function F229ChatSurfaceParityPage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    seedFixture();
    setReady(true);
  }, []);

  if (!ready) return null;

  return (
    <main className="min-h-screen bg-cafe-bg p-6" data-testid="f229-chat-surface-parity">
      <header className="mx-auto mb-4 max-w-[1500px]">
        <h1 className="text-lg font-semibold text-cafe-primary">F229 · 同一 thread，两种 density</h1>
        <p className="text-sm text-cafe-secondary">
          消息语义、history、renderer、actions 与 composer 相同；仅布局密度不同。
        </p>
      </header>
      <div className="mx-auto grid max-w-[1500px] gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex h-[720px] min-w-0 flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-sm">
          <div className="border-b border-cafe px-4 py-2 text-sm font-semibold text-cafe-primary">Full Chat</div>
          <ThreadChatSurface threadId={THREAD_ID} density="full" messageConfirmations={messageConfirmations} />
        </section>
        <section className="flex h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-lg">
          <div className="border-b border-cafe px-3 py-2 text-sm font-semibold text-cafe-primary">
            Compact Cat Ball · 360 × 520
          </div>
          <ThreadChatSurface
            threadId={THREAD_ID}
            density="compact"
            composerPlaceholder="继续聊聊…"
            messageConfirmations={messageConfirmations}
          />
        </section>
      </div>
    </main>
  );
}
