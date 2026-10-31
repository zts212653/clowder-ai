'use client';
import type { ArtifactReviewRound, ArtifactReviewView, PublicationReviewContext } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import {
  contentContextSelectionKey,
  publicationContextCatalogueSchema,
  publicationContextLabel,
} from '@/components/workbench/publication-context';
import { apiFetch } from '@/utils/api-client';
import { checked, json } from './modification-http';

/** Changes only the workflow view; the owner still authorizes the selected review on mount. */
export function ReviewContextSelector({
  view,
  round,
  onChange,
}: {
  view: ArtifactReviewView;
  round: ArtifactReviewRound;
  onChange: (context: PublicationReviewContext) => void;
}) {
  const { contentRef, ownerRevision } = round.asset;
  const ownerUserId = view.review.task.ownerUserId;
  const key = JSON.stringify([ownerUserId, contentRef, ownerRevision, view.review.revision]);
  const [catalogue, setCatalogue] = useState<{ key: string; contexts: PublicationReviewContext[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const contexts = catalogue?.key === key ? catalogue.contexts : null;
  useEffect(() => {
    const refresh = () => setAttempt((n) => n + 1);
    window.addEventListener('cat-cafe:artifact-review-changed', refresh);
    window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', refresh);
    return () => {
      window.removeEventListener('cat-cafe:artifact-review-changed', refresh);
      window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', refresh);
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setError(null);
    setCatalogue(null);
    void apiFetch('/api/content-reviews/resolve', { ...json({ contentRef, ownerRevision }), signal: abort.signal })
      .then(checked<unknown>)
      .then((raw) => {
        const result = publicationContextCatalogueSchema.parse(raw);
        if (abort.signal.aborted) return;
        if (result.ownerUserId !== ownerUserId) throw new Error('当前身份已变化，请重新打开作品。');
        setCatalogue({ key, contexts: result.contexts });
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '暂时无法核对其他讨论。');
      });
    return () => abort.abort();
  }, [key, contentRef, ownerRevision, ownerUserId, attempt]);
  const current = contexts?.find((item) => item.reviewId === view.review.reviewId);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-cafe-muted">
      <label className="flex min-w-0 max-w-full items-center gap-2">
        <span className="shrink-0">讨论/修改任务</span>
        <select
          aria-label="作品讨论上下文"
          value={view.review.reviewId}
          disabled={!contexts}
          className="min-w-0 max-w-full rounded border border-cafe-subtle bg-cafe-surface p-1"
          onChange={(event) => {
            const next = contexts?.find((item) => item.reviewId === event.target.value);
            if (!next || next.reviewId === view.review.reviewId) return;
            try {
              localStorage.setItem(contentContextSelectionKey(ownerUserId, contentRef), next.reviewId);
            } catch {
              setError('选择尚未保存到浏览器，请保留页面。');
              return;
            }
            onChange(next);
          }}
        >
          {!current ? <option value={view.review.reviewId}>当前讨论 · 第 {round.number} 版</option> : null}
          {contexts?.map((item) => (
            <option key={item.reviewId} value={item.reviewId}>
              {publicationContextLabel(item)}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <span role="alert">{error}</span>
      ) : !contexts ? (
        <span role="status">正在核对原讨论…</span>
      ) : !current ? (
        <span role="status">当前讨论的关联已变化，请核对后选择；草稿仍保留。</span>
      ) : null}
      {error ? (
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          重新读取
        </button>
      ) : null}
    </div>
  );
}
