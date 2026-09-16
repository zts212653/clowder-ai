'use client';
import type { ArtifactReviewAuditEntry } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ReviewActor } from './ReviewActor';
import { invalidateArtifactReviewAccess } from './review-access-invalidation';

const labels: Record<string, string> = {
  prepare: '开始审阅',
  annotate: '添加标注',
  reply: '回复讨论',
  edit: '修改文字',
  set_annotation_state: '更改标注状态',
  request_judgment: '请求人的判断',
  submit_feedback: '交还修改意见',
  decide: '作出审阅结论',
  reopen: '重新打开审阅',
  respond_with_version: '发布新版并逐条回应',
  retire_attention: '撤回过时的判断请求',
};
export function ReviewHistory({
  reviewId,
  revision,
  ownerUserId,
}: {
  reviewId: string;
  revision: number;
  ownerUserId: string;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ArtifactReviewAuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    setEntries([]);
    setNext(null);
  }, [revision]);
  useEffect(() => {
    if (!open) return;
    generation.current += 1;
    const controller = new AbortController();
    void apiFetch(`/api/artifact-reviews/${encodeURIComponent(reviewId)}/history?limit=10`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) invalidateArtifactReviewAccess(reviewId);
          throw new Error('history unavailable');
        }
        const data = (await response.json()) as { entries: ArtifactReviewAuditEntry[]; nextCursor: number | null };
        if (!controller.signal.aborted) {
          setEntries(data.entries);
          setNext(data.nextCursor);
          setError(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => {
      generation.current += 1;
      controller.abort();
    };
  }, [open, reviewId, revision]);
  async function more() {
    const scope = generation.current;
    try {
      const response = await apiFetch(
        `/api/artifact-reviews/${encodeURIComponent(reviewId)}/history?afterRevision=${next}&limit=10`,
      );
      if (scope !== generation.current) return;
      if (!response.ok) {
        if ([401, 403, 404, 410].includes(response.status)) invalidateArtifactReviewAccess(reviewId);
        throw new Error('history unavailable');
      }
      const data = (await response.json()) as { entries: ArtifactReviewAuditEntry[]; nextCursor: number | null };
      if (scope !== generation.current) return;
      setEntries((previous) => [...previous, ...data.entries]);
      setNext(data.nextCursor);
      setError(false);
    } catch {
      if (scope === generation.current) setError(true);
    }
  }
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-xl border border-cafe-subtle p-3"
    >
      <summary className="cursor-pointer text-xs font-semibold text-cafe-secondary">完整修改与裁决历史</summary>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-cafe-error">
          暂时无法读取历史，请稍后重新打开。
        </p>
      ) : null}
      <ol className="mt-3 space-y-3">
        {entries.map((entry) => {
          const detail = asRecord(entry.detail),
            request = asRecord(detail?.request),
            action = asRecord(request?.action);
          const before = asRecord(detail?.predecessor);
          const body =
            typeof action?.body === 'string'
              ? action.body
              : typeof action?.explanation === 'string'
                ? action.explanation
                : null;
          return (
            <li key={entry.receipt.receiptRef} className="rounded-lg bg-cafe-surface-sunken p-3 text-xs">
              <p className="font-semibold text-cafe-black">
                第 {entry.round} 版 · {labels[entry.kind] ?? '审阅操作'}
                {entry.receipt.outcome === 'aborted' ? '（未生效）' : ''}
              </p>
              <div className="mt-2">
                {entry.receipt.actor.kind === 'owner' ? (
                  <span className="text-cafe-muted">审阅系统</span>
                ) : (
                  <ReviewActor actor={entry.receipt.actor} ownerUserId={ownerUserId} />
                )}
              </div>
              {entry.kind === 'edit' && typeof before?.body === 'string' ? (
                <p className="mt-2 whitespace-pre-wrap break-words text-cafe-muted">修改前：{before.body}</p>
              ) : null}
              {body ? (
                <p className="mt-2 whitespace-pre-wrap break-words leading-5 text-cafe-secondary">{body}</p>
              ) : null}
              <time className="mt-2 block text-micro text-cafe-muted" dateTime={entry.receipt.createdAt}>
                {new Date(entry.receipt.createdAt).toLocaleString()}
              </time>
            </li>
          );
        })}
      </ol>
      {next !== null ? (
        <button type="button" className="mt-3 text-xs text-cafe-accent" onClick={() => void more()}>
          继续查看历史
        </button>
      ) : null}
    </details>
  );
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
