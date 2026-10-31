'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ThreadNativeReviewRunV1, ThreadNativeReviewTarget } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

type TargetKind = ThreadNativeReviewTarget['kind'];

export function ThreadNativeReviewSettingsContent({ threadId }: { threadId: string }) {
  const [reviews, setReviews] = useState<ThreadNativeReviewRunV1[]>([]);
  const [activeReviewIds, setActiveReviewIds] = useState<string[]>([]);
  const [targetKind, setTargetKind] = useState<TargetKind>('uncommitted_changes');
  const [baseBranch, setBaseBranch] = useState('origin/main');
  const [commitSha, setCommitSha] = useState('');
  const [instructions, setInstructions] = useState('');
  const [delivery, setDelivery] = useState<'inline' | 'detached'>('inline');
  const [nativeTargets, setNativeTargets] = useState<Array<{ catId: string }>>([]);
  const [selectedCatId, setSelectedCatId] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReviews = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        const response = await apiFetch(`/api/threads/${threadId}/reviews/native`);
        if (!response.ok) throw new Error('load_failed');
        const body = (await response.json()) as {
          reviews: ThreadNativeReviewRunV1[];
          activeReviewIds?: string[];
          nativeTargets?: Array<{ catId: string }>;
        };
        setReviews([...body.reviews].reverse());
        setActiveReviewIds(body.activeReviewIds ?? []);
        if (body.nativeTargets) {
          setNativeTargets(body.nativeTargets);
          setSelectedCatId((current) =>
            body.nativeTargets?.some((target) => target.catId === current)
              ? current
              : (body.nativeTargets?.[0]?.catId ?? ''),
          );
        }
        setError(null);
      } catch {
        setError('原生 Review 记录读取失败。');
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [threadId],
  );

  useEffect(() => {
    void loadReviews(true);
  }, [loadReviews]);

  useEffect(() => {
    if (
      activeReviewIds.length === 0 &&
      !reviews.some((review) => review.status === 'queued' || review.status === 'running')
    ) {
      return;
    }
    const timer = window.setInterval(() => void loadReviews(), 5_000);
    return () => window.clearInterval(timer);
  }, [activeReviewIds, loadReviews, reviews]);

  const startReview = async (event: FormEvent) => {
    event.preventDefault();
    const target = buildTarget(targetKind, { baseBranch, commitSha, instructions });
    if (!target) {
      setError('请补全要审查的目标。');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/threads/${threadId}/reviews/native`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, delivery, ...(selectedCatId ? { catId: selectedCatId } : {}) }),
      });
      if (!response.ok && response.status !== 202) throw new Error('start_failed');
      const body = (await response.json()) as { review: ThreadNativeReviewRunV1 };
      setReviews((current) => [body.review, ...current.filter((review) => review.id !== body.review.id)]);
    } catch {
      setError('Review 没有启动；已有记录不受影响。');
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <p className="px-3 py-6 text-center text-xs text-cafe-muted">正在读取 Review…</p>;

  return (
    <div className="space-y-3 px-3 py-3">
      <p className="rounded-lg border border-cafe-subtle bg-cafe-surface-elevated px-2.5 py-2 text-micro text-cafe-muted">
        Codex 原生 Review 是当前 Codex 会话的结构化检查模式，不等于家里的独立 merge-gate
        reviewer；要合入代码时仍需非作者审查。
      </p>
      <form className="space-y-2" onSubmit={startReview}>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-micro text-cafe-muted">
            审查目标
            <select
              name="targetKind"
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as TargetKind)}
              className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1.5 text-xs text-cafe-black"
            >
              <option value="uncommitted_changes">未提交改动</option>
              <option value="base_branch">相对分支</option>
              <option value="commit">指定提交</option>
              <option value="custom">自定义说明</option>
            </select>
          </label>
          <label className="text-micro text-cafe-muted">
            运行方式
            <select
              name="delivery"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as 'inline' | 'detached')}
              className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1.5 text-xs text-cafe-black"
            >
              <option value="inline">当前会话</option>
              <option value="detached">独立 Codex 线程</option>
            </select>
          </label>
        </div>
        {nativeTargets.length > 1 && (
          <label className="block text-micro text-cafe-muted">
            Codex 会话
            <select
              name="reviewCatId"
              value={selectedCatId}
              onChange={(event) => setSelectedCatId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2 py-1.5 text-xs text-cafe-black"
            >
              {nativeTargets.map((target) => (
                <option key={target.catId} value={target.catId}>
                  {target.catId}
                </option>
              ))}
            </select>
          </label>
        )}
        {targetKind === 'base_branch' && (
          <input
            name="baseBranch"
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
            placeholder="origin/main"
            className="w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2.5 py-1.5 text-xs text-cafe-black"
          />
        )}
        {targetKind === 'commit' && (
          <input
            name="commitSha"
            value={commitSha}
            onChange={(event) => setCommitSha(event.target.value)}
            placeholder="commit SHA"
            className="w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2.5 py-1.5 text-xs text-cafe-black"
          />
        )}
        {targetKind === 'custom' && (
          <textarea
            name="instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={2}
            placeholder="明确审查范围与风险"
            className="w-full rounded-lg border border-cafe-subtle bg-cafe-bg px-2.5 py-2 text-xs text-cafe-black"
          />
        )}
        {error && <p className="text-micro text-conn-red-text">{error}</p>}
        <button
          type="submit"
          disabled={working}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs text-[var(--cafe-accent-foreground)]"
        >
          {working ? '正在启动…' : '开始 Codex Review'}
        </button>
      </form>
      <section aria-label="原生 Review 记录" className="space-y-2 border-t border-cafe-subtle pt-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-cafe-black">最近结果</h3>
          <button type="button" onClick={() => void loadReviews()} className="text-micro text-cafe-accent">
            刷新
          </button>
        </div>
        {reviews.length === 0 && <p className="text-micro text-cafe-muted">还没有原生 Review 记录。</p>}
        {reviews.slice(0, 5).map((review) => (
          <ReviewResult key={review.id} review={review} />
        ))}
      </section>
    </div>
  );
}

function buildTarget(
  kind: TargetKind,
  fields: { baseBranch: string; commitSha: string; instructions: string },
): ThreadNativeReviewTarget | null {
  if (kind === 'uncommitted_changes') return { kind };
  if (kind === 'base_branch') return fields.baseBranch.trim() ? { kind, branch: fields.baseBranch.trim() } : null;
  if (kind === 'commit') return fields.commitSha.trim() ? { kind, sha: fields.commitSha.trim() } : null;
  return fields.instructions.trim() ? { kind, instructions: fields.instructions.trim() } : null;
}

function ReviewResult({ review }: { review: ThreadNativeReviewRunV1 }) {
  const summary = review.result?.summary ?? review.items.at(-1)?.text;
  return (
    <article className="rounded-lg border border-cafe-subtle bg-cafe-bg px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-micro">
        <span className="font-medium text-cafe-black">{targetLabel(review.target)}</span>
        <span className="text-cafe-muted">{statusLabel(review.status)}</span>
      </div>
      {summary && <p className="mt-1 whitespace-pre-wrap text-micro text-cafe-secondary">{summary}</p>}
      {review.status === 'unavailable' && (
        <p className="mt-1 text-micro text-cafe-muted">Codex 会话暂不可用；可重新发起，不会覆盖这条记录。</p>
      )}
      {review.truncated && (
        <p className="mt-1 text-micro text-cafe-muted">较早的 Review 进度已超出当前历史窗口；这里保留终态结果。</p>
      )}
    </article>
  );
}

function targetLabel(target: ThreadNativeReviewTarget): string {
  if (target.kind === 'uncommitted_changes') return '未提交改动';
  if (target.kind === 'base_branch') return `相对 ${target.branch}`;
  if (target.kind === 'commit') return `提交 ${target.sha.slice(0, 10)}`;
  return '自定义审查';
}

function statusLabel(status: ThreadNativeReviewRunV1['status']): string {
  return { queued: '排队中', running: '检查中', completed: '已完成', failed: '失败', unavailable: '暂不可用' }[status];
}
