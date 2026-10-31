'use client';

import { useEffect, useState } from 'react';
import { ChatMessage } from '@/components/ChatMessage';
import { QueuePanel } from '@/components/QueuePanel';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { type QueueEntry, useChatStore } from '@/stores/chatStore';

const failedResponse: Message = {
  id: 'preview-failed-response',
  type: 'assistant',
  from: { kind: 'agent', catId: 'codex-astra' },
  catId: 'codex-astra',
  content: '检查已通过，通知尚未结算',
  timestamp: 2,
  lifecycle: {
    kind: 'response',
    orderKey: '2:preview-failed-response',
    invocationId: 'finished-child',
    targetId: 'codex-astra',
    inputEntryIds: ['completed-wake'],
    inputMessageIds: ['preview-wake'],
    status: 'failed',
    startedAt: 1,
    completedAt: 2,
  },
};

export function AdoptedHoldPreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const pending: QueueEntry = {
      id: 'adopted-hold-preview',
      threadId: 'issue1371-preview',
      userId: 'preview-owner',
      messageId: 'preview-pending-source',
      mergedMessageIds: [],
      content: '等待下一次明确通知',
      from: { kind: 'agent', catId: 'codex-astra' },
      sourceCategory: 'a2a',
      targetCats: ['codex-astra'],
      intent: 'execute',
      status: 'queued',
      createdAt: Date.now(),
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
      messages: [failedResponse],
      activeInvocations: {},
      catInvocations: {},
      queue: [
        pending,
        {
          ...pending,
          id: 'routine-scheduler',
          from: { kind: 'system', service: 'scheduler' },
          sourceCategory: 'scheduled',
          content: '[定时任务] routine internal control',
          recoveryActions: [],
        },
      ],
    });
    setReady(true);
  }, []);
  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-4 text-cafe sm:p-8" data-ready={ready}>
      <section className="mx-auto max-w-3xl space-y-5">
        <header>
          <h1 className="text-xl font-semibold">通知失败与后续待投递消息</h1>
          <p className="mt-2 text-sm text-cafe-secondary">
            开发预览 · 失败保留在原回复，队列仅含待投递目标，不调用模型。
          </p>
        </header>
        <ChatMessage message={failedResponse} threadId="issue1371-preview" getCatById={() => undefined} />
        <QueuePanel threadId="issue1371-preview" />
      </section>
    </main>
  );
}
