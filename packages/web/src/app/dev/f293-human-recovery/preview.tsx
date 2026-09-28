'use client';

import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as Message } from '@/stores/chatStore';

const reasons = [{ code: 'quota_exhausted', summary: 'quota exhausted', sourceRefs: ['fixture:quota'] }];
function receipt(id: string, humanAttempt: boolean): Message {
  return {
    id,
    type: 'system',
    content: '',
    timestamp: Date.UTC(2026, 8, 6, 11, 57),
    extra: {
      systemInfo: {
        v: 1,
        fallbackCatId: 'codex-astra',
        payload: {
          type: 'routing_preflight',
          v: 1,
          ownerId: 'preview-owner',
          observedAt: Date.UTC(2026, 8, 6, 11, 57),
          resolverState: 'fresh',
          snapshotRef: 'fixture:snapshot',
          sourceMessageId: 'original-message',
          ...(!humanAttempt ? { retryInvocationId: 'f293-preview-invocation' } : {}),
          target: {
            targetCatId: 'codex-astra',
            disposition: humanAttempt ? 'warned' : 'rejected',
            reasons,
            alternatives: [],
            automaticRetryAt: Date.UTC(2026, 8, 6, 12, 2),
            ...(humanAttempt ? { ownerAttempt: true } : {}),
          },
        },
      },
    },
  };
}

export function HumanRecoveryPreview() {
  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-4 text-cafe sm:p-8" data-testid="f293-recovery-preview">
      <section className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">发送与恢复</h1>
          <p className="mt-2 text-sm text-cafe-secondary">开发预览 · 模拟回执，不调用真实模型。</p>
        </header>
        <section aria-label="自动发送被拦截" className="rounded-xl border border-cafe bg-cafe-surface py-6">
          <ChatMessage message={receipt('blocked', false)} threadId="f293-preview" getCatById={() => undefined} />
        </section>
        <section aria-label="人工主动尝试" className="rounded-xl border border-cafe bg-cafe-surface py-6">
          <ChatMessage message={receipt('attempt', true)} threadId="f293-preview" getCatById={() => undefined} />
        </section>
      </section>
    </main>
  );
}
