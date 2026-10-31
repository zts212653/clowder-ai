'use client';

import type { QueueRecoveryAction } from '@cat-cafe/shared';
import { useState } from 'react';
import { reconcileThreadWithServer } from '@/hooks/queue-reconciliation';
import type { QueueEntry } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export function QueueTargetRetryButton({
  entry,
  action,
  label = '重试',
}: {
  entry: QueueEntry;
  action: Extract<QueueRecoveryAction, { kind: 'retry_target' | 'repeat_target' }>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedAction, setSubmittedAction] = useState<typeof action | null>(null);
  const submitted = submittedAction === action;
  const repeat = action.kind === 'repeat_target';
  const path = `/api/threads/${encodeURIComponent(entry.threadId)}/messages/${encodeURIComponent(entry.messageId ?? '')}/routing-targets/${encodeURIComponent(action.targetCatId)}/${repeat ? 'repeat' : 'retry'}`;
  if (
    !entry.messageId ||
    action.entryId !== entry.id ||
    !entry.targetCats.includes(action.targetCatId) ||
    action.request.method !== 'POST' ||
    action.request.path !== path
  )
    return null;
  const retry = async () => {
    if (busy || submitted) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(path, { method: 'POST' });
      const body = await result.json().catch(() => ({}));
      if (!result.ok || body.status !== (repeat ? 'repeated' : 'retrying'))
        throw new Error(body.error ?? '重试未能开始，请重新读取状态');
      setSubmittedAction(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试未能开始');
    } finally {
      setBusy(false);
      await reconcileThreadWithServer(entry.threadId, () => false, 'QueueTargetRetry');
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={busy || submitted}
        data-queue-retry-target={action.targetCatId}
        className="rounded text-xs text-cafe-secondary hover:underline disabled:opacity-60"
        onClick={() => void retry()}
      >
        {submitted ? (repeat ? '已再次发送' : '已提交重试') : busy ? '发送中…' : repeat ? '再发一次' : label}
      </button>
      {repeat ? <span>如果它其实收到了，会再回一遍</span> : null}
      {error ? (
        <span role="alert" className="text-xs text-conn-red-text">
          {error}
        </span>
      ) : null}
    </span>
  );
}
