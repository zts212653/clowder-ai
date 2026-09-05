'use client';

import { CloudBindingRecoveryCardView } from '@/components/CloudBindingRecoveryCard';

const THREAD_ID = 'thread-f247-inline-recovery-preview';
const SOURCE_ID = 'source-f247-inline-recovery-preview';
const TARGET_ID = 'gpt-pro';
const ATTEMPT_ID = 'attempt-f247-inline-recovery-preview';
const noop = () => undefined;

const candidates = [
  {
    conversationId: '6a928d55-ed7c-83ee-adbf-567890abcdef',
    chatUrl: 'https://chatgpt.com/c/6a928d55-ed7c-83ee-adbf-567890abcdef',
    displayTitle: '砚砚喵的工作会话',
    authorizedAt: '2026-09-04T08:00:00.000Z',
    updatedAt: '2026-09-04T08:00:00.000Z',
  },
  {
    conversationId: '9d25d794-5711-4e32-8c80-123456789abc',
    chatUrl: 'https://chatgpt.com/c/9d25d794-5711-4e32-8c80-123456789abc',
    authorizedAt: '2026-09-03T08:00:00.000Z',
    updatedAt: '2026-09-03T08:00:00.000Z',
  },
];

function MessageFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 shadow-sm">
      <p className="text-micro font-semibold uppercase tracking-wider text-cafe-muted">{title}</p>
      <div className="mt-3 ml-auto max-w-xl rounded-2xl rounded-br-md bg-[var(--color-cocreator-surface)] px-4 py-3 text-[var(--color-cocreator-text)]">
        <p className="text-sm">@gpt-pro 帮我看看这条消息喵！</p>
        {children}
      </div>
    </section>
  );
}

function baseProps() {
  return {
    threadId: THREAD_ID,
    sourceMessageId: SOURCE_ID,
    targetCatId: TARGET_ID,
    attemptId: ATTEMPT_ID,
    phase: 'idle' as const,
    operationError: null,
    onRefresh: noop,
    onSelect: noop,
    onToggleChoices: noop,
    onSubmit: noop,
  };
}

export default function F247InlineRecoveryPreview() {
  return (
    <main className="mx-auto min-h-screen max-w-5xl space-y-4 bg-cafe-bg p-4 sm:p-8">
      <header>
        <p className="text-micro font-semibold uppercase tracking-wider text-cafe-muted">F247 design gate</p>
        <h1 className="mt-1 text-xl font-bold text-cafe">未绑定恢复卡 · source-bound states</h1>
        <p className="mt-1 text-sm text-cafe-secondary">桌面与窄屏都应留在原消息旁，不弹全局 modal。</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <MessageFrame title="唯一候选 · 自动预选">
          <CloudBindingRecoveryCardView
            {...baseProps()}
            loadState={{ kind: 'ready', candidates: [candidates[0]], boundConversationId: null }}
            selectedConversationId={candidates[0]?.conversationId ?? null}
            showChoices={false}
          />
        </MessageFrame>

        <MessageFrame title="多个候选 · 原地选择">
          <CloudBindingRecoveryCardView
            {...baseProps()}
            sourceMessageId={`${SOURCE_ID}-many`}
            loadState={{ kind: 'ready', candidates, boundConversationId: null }}
            selectedConversationId={null}
            showChoices
          />
        </MessageFrame>

        <MessageFrame title="没有候选 · 显式授权">
          <CloudBindingRecoveryCardView
            {...baseProps()}
            sourceMessageId={`${SOURCE_ID}-none`}
            loadState={{ kind: 'ready', candidates: [], boundConversationId: null }}
            selectedConversationId={null}
            showChoices={false}
          />
        </MessageFrame>

        <MessageFrame title="已绑定 · retry 仍失败">
          <CloudBindingRecoveryCardView
            {...baseProps()}
            sourceMessageId={`${SOURCE_ID}-retry`}
            loadState={{
              kind: 'ready',
              candidates: [candidates[1]],
              boundConversationId: candidates[1]?.conversationId ?? null,
            }}
            selectedConversationId={candidates[1]?.conversationId ?? null}
            showChoices={false}
            operationError="会话已绑定，但这条消息还没有重新发送。发送状态已经变化，请查看最新状态。"
          />
        </MessageFrame>
      </div>
    </main>
  );
}
