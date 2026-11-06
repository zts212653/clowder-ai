'use client';

import { useState } from 'react';
import { reconcileThreadWithServer } from '@/hooks/queue-reconciliation';
import { apiFetch } from '@/utils/api-client';

/** Actions belong to the original History delivery, even when no Queue entry remains. */
export function HistoryAppendActions({
  threadId,
  messageId,
  delivery,
  canRepeat,
  repeatKind = 'unknown',
}: {
  threadId: string;
  messageId: string;
  delivery: { targetId: string; responseMessageId: string; invocationId?: string };
  repeatKind?: 'unknown' | 'not_accepted' | 'incomplete';
  canRepeat: boolean;
}) {
  const [busy, setBusy] = useState<'reconcile' | 'repeat' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repeated, setRepeated] = useState(false);
  const run = async (action: 'reconcile' | 'repeat') => {
    if (busy || (action === 'repeat' && repeated)) return;
    setBusy(action);
    setError(null);
    try {
      const path = `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/routing-targets/${encodeURIComponent(delivery.targetId)}/${action}`;
      const result = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedResponseMessageId: delivery.responseMessageId,
          expectedInvocationId: delivery.invocationId,
        }),
      });
      const body = await result.json().catch(() => ({}));
      if (!result.ok || body.status !== (action === 'repeat' ? 'repeated' : 'checked'))
        throw new Error(body.error ?? '投递状态已变化，请重新核对');
      if (action === 'repeat') setRepeated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '未能完成，请稍后再试');
    } finally {
      setBusy(null);
      await reconcileThreadWithServer(threadId, () => false, 'HistoryAppendActions');
    }
  };
  const buttonClass = 'rounded text-xs text-cafe-secondary hover:underline disabled:opacity-60';
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      {repeatKind === 'unknown' ? (
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run('reconcile')}>
          {busy === 'reconcile' ? '核对中…' : '核对状态'}
        </button>
      ) : null}
      {canRepeat ? (
        <>
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null || repeated}
            onClick={() => void run('repeat')}
          >
            {repeated
              ? '已再次发送'
              : busy === 'repeat'
                ? '发送中…'
                : repeatKind === 'not_accepted'
                  ? '重新发送'
                  : '再发一次'}
          </button>
          {repeatKind !== 'not_accepted' ? (
            <span className="text-xs text-cafe-muted">
              {repeatKind === 'incomplete' ? '上次可能已执行一部分，再发可能重复执行' : '如果它其实收到了，会再回一遍'}
            </span>
          ) : null}
        </>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-conn-red-text">
          {error}
        </span>
      ) : null}
    </span>
  );
}
