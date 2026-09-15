'use client';

import { useEffect, useState } from 'react';
import { QueuePanel } from '@/components/QueuePanel';
import { type QueueEntry, useChatStore } from '@/stores/chatStore';

export function AdoptedHoldPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const failed: QueueEntry = {
      id: 'adopted-hold-preview',
      threadId: 'issue1371-preview',
      userId: 'preview-owner',
      messageId: 'preview-wake',
      mergedMessageIds: [],
      content: '[定时任务] 持球唤醒：检查已通过，通知尚未结算',
      source: 'connector',
      sourceCategory: 'scheduled',
      targetCats: ['codex-astra'],
      intent: 'execute',
      status: 'queued',
      createdAt: Date.now(),
      targetStates: { 'codex-astra': 'failed' },
      queueReceipt: {
        version: 1,
        entryId: 'adopted-hold-preview',
        reminderAttempts: [],
        targets: [{ catId: 'codex-astra', state: 'failed', invocationId: 'finished-child', seenAt: Date.now() - 1000 }],
      },
      recoveryActions: [
        {
          id: 'queue-withdraw:adopted-hold-preview',
          entryId: 'adopted-hold-preview',
          kind: 'withdraw',
          request: { method: 'DELETE', path: '/api/threads/issue1371-preview/queue/adopted-hold-preview' },
        },
      ],
    };
    useChatStore.setState({
      currentThreadId: 'issue1371-preview',
      messages: [],
      activeInvocations: {},
      catInvocations: {},
      queue: [
        failed,
        {
          ...failed,
          id: 'routine-scheduler',
          content: '[定时任务] routine internal control',
          targetStates: { 'codex-astra': 'queued' },
          queueReceipt: undefined,
          recoveryActions: [],
        },
      ],
      queuePaused: true,
      queuePauseReason: 'failed',
    });
    setReady(true);
  }, []);
  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-4 text-cafe sm:p-8" data-ready={ready}>
      <section className="mx-auto max-w-3xl space-y-5">
        <header>
          <h1 className="text-xl font-semibold">通知结算与队列恢复</h1>
          <p className="mt-2 text-sm text-cafe-secondary">开发预览 · 模拟回执，操作由浏览器测试拦截，不调用模型。</p>
        </header>
        <QueuePanel threadId="issue1371-preview" />
      </section>
    </main>
  );
}
