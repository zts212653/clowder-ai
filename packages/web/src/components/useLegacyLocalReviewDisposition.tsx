'use client';

import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

type DialogFacts = {
  decisionId: string;
  reviewerCatId: string;
  reviewedHeadSha: string;
  subjectRef: string;
};

function showErrorToast(title: string, body?: Record<string, unknown>) {
  useToastStore.getState().addToast({
    type: 'error',
    title,
    message: (body?.error as string) ?? '操作未成功，请重试',
    duration: 4000,
  });
}

export function isLegacyLocalReviewDispositionCandidate(message: ChatMessage): boolean {
  return Boolean(
    message.catId &&
      !message.isStreaming &&
      message.extra?.coordination?.phase === 'terminal' &&
      message.extra.coordination.subjectRef?.startsWith('pr:') &&
      message.extra.crossPost?.sourceThreadId &&
      !message.extra.localReviewVerdict &&
      !message.extra.legacyLocalReviewDisposition,
  );
}

export function useLegacyLocalReviewDisposition(message: ChatMessage) {
  const [dialog, setDialog] = useState<DialogFacts | null>(null);
  const settlingRef = useRef(false);
  const candidate = isLegacyLocalReviewDispositionCandidate(message);

  const begin = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/messages/${message.id}/legacy-local-review-disposition`, { method: 'GET' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.outcome !== 'eligible') {
        showErrorToast('这条 Review 当前无需结算', body);
        return;
      }
      setDialog({
        decisionId: crypto.randomUUID(),
        reviewerCatId: body.reviewerCatId,
        reviewedHeadSha: body.reviewedHeadSha,
        subjectRef: body.subjectRef,
      });
    } catch {
      showErrorToast('无法核验 Review 结算状态');
    }
  }, [message.id]);

  const settle = useCallback(
    async (verdict: 'approved' | 'changes_requested') => {
      if (!dialog || settlingRef.current) return;
      settlingRef.current = true;
      try {
        const response = await apiFetch(`/api/messages/${message.id}/legacy-local-review-disposition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decisionId: dialog.decisionId, verdict }),
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body.outcome === 'committed') {
          setDialog(null);
          useToastStore.getState().addToast({
            type: 'success',
            title: 'Review 已结算',
            message: '旧 lease 已关闭，作者续跑已进入同一条 Queue 生命周期。',
            duration: 4000,
          });
          return;
        }
        if (body.outcome === 'continuation_pending') {
          showErrorToast('Review 已结算，作者续跑暂未入队；可直接重试', body);
          return;
        }
        showErrorToast('Review 结算失败', body);
      } catch {
        showErrorToast('Review 结算失败');
      } finally {
        settlingRef.current = false;
      }
    },
    [dialog, message.id],
  );

  const dialogElement = dialog ? (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legacy-review-disposition-title"
    >
      <button
        type="button"
        className="absolute inset-0"
        aria-label="取消结算旧 Review"
        onClick={() => setDialog(null)}
      />
      <div className="relative mx-4 w-full max-w-md rounded-xl bg-cafe-surface p-6 shadow-xl">
        <h3 id="legacy-review-disposition-title" className="mb-2 text-base font-semibold">
          结算旧 Review
        </h3>
        <p className="mb-3 text-sm text-cafe-secondary">
          原消息只作为定位证据，系统不会从正文猜 verdict。请选择真实结论；这会原子关闭旧 lease，并唤醒作者继续。
        </p>
        <dl className="mb-4 space-y-1 text-xs text-cafe-muted">
          <div className="flex gap-2">
            <dt className="shrink-0">Reviewer</dt>
            <dd className="min-w-0 break-all">{dialog.reviewerCatId}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0">PR</dt>
            <dd className="min-w-0 break-all">{dialog.subjectRef}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0">HEAD</dt>
            <dd className="min-w-0 break-all font-mono">{dialog.reviewedHeadSha}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => setDialog(null)}
            className="rounded-lg px-4 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void settle('changes_requested')}
            className="rounded-lg bg-semantic-critical px-4 py-2 text-sm text-[var(--cafe-surface)] hover:opacity-90"
          >
            需要修改
          </button>
          <button
            type="button"
            onClick={() => void settle('approved')}
            className="rounded-lg bg-semantic-info px-4 py-2 text-sm text-[var(--cafe-surface)] hover:opacity-90"
          >
            通过
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { begin, candidate, dialog: dialogElement };
}
