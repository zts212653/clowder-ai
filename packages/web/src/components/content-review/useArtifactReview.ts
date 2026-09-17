'use client';
import {
  type ArtifactReviewAction,
  type ArtifactReviewCommand,
  type ArtifactReviewView,
  artifactReviewSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { invalidateArtifactReviewAccess, REVIEW_ACCESS_REVOKED } from './review-access-invalidation';
import { clearCommittedReviewDraft } from './review-draft-commit';
import { clearReviewRetryRecord, readReviewRetryRecord } from './review-retry-storage';

const messages: Record<string, string> = {
  revision_conflict: '讨论已有新内容。请刷新后核对，再提交你的草稿。',
  task_changed: '原任务已有变化，请先核对任务；草稿仍然保留。',
  asset_changed: '猫已经发布了新版本，请先核对版本。旧标注仍留在原版。',
  version_pending: '新版正在保存和恢复，稍后即可继续。',
  invalid_action: '这轮暂时不能执行这个操作，请核对当前版本和审阅状态。',
  operation_reused: '这个保存编号已用于另一项操作，尚未提交当前草稿。',
};

export function reviewDraftPrefix(userId: string, reviewId: string): string {
  return `cat-cafe:review:${userId}:${reviewId}:`;
}
export function useArtifactReview(reviewId: string) {
  const [view, setView] = useState<ArtifactReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<ArtifactReviewCommand | null>(null);
  const current = useRef<ArtifactReviewView | null>(null);
  const pendingRef = useRef<ArtifactReviewCommand | null>(null);
  const settledOperation = useRef<string | null>(null);
  const retryStorageAvailable = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const install = useCallback((candidate: ArtifactReviewView) => {
    artifactReviewSchema.parse(candidate.review);
    if (
      current.current &&
      (current.current.review.revision > candidate.review.revision ||
        current.current.authority.taskRevision > candidate.authority.taskRevision)
    )
      return;
    current.current = candidate;
    setView(candidate);
  }, []);
  const clearRevoked = useCallback(() => {
    generation.current += 1;
    controllerRef.current?.abort();
    const previous = current.current;
    try {
      if (previous) {
        const prefix = reviewDraftPrefix(previous.review.task.ownerUserId, reviewId);
        for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
      }
    } catch {
      /* Browser storage may be blocked; fresh authority still fences every future mount. */
    }
    pendingRef.current = null;
    settledOperation.current = null;
    setPending(null);
    current.current = null;
    setView(null);
    setLoading(false);
    setSaving(false);
    setError('这份内容现在不可访问，旧预览已关闭。');
  }, [reviewId]);
  const revokeAccess = useCallback(() => invalidateArtifactReviewAccess(reviewId), [reviewId]);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const scope = generation.current;
    try {
      const response = await apiFetch(
        `/api/artifact-reviews/${encodeURIComponent(reviewId)}`,
        { signal: controller.signal },
        { afterCurrentGet: true },
      );
      if (controller.signal.aborted || scope !== generation.current) return;
      if (!response.ok) {
        if ([401, 403, 404, 410].includes(response.status)) {
          revokeAccess();
          throw new Error('这份内容现在不可访问，旧预览和草稿已清除。');
        }
        throw new Error('暂时无法核对这份审阅，请重试。已保存的讨论和你的草稿仍然保留。');
      }
      const next = (await response.json()) as ArtifactReviewView;
      if (controller.signal.aborted || scope !== generation.current) return;
      install(next);
      setError(null);
      const key = `${reviewDraftPrefix(next.review.task.ownerUserId, reviewId)}pending`;
      if (!pendingRef.current) {
        const stored = readReviewRetryRecord(key, reviewId);
        retryStorageAvailable.current = stored.available;
        if (!stored.available) setError('审阅已加载，但浏览器暂时无法读取重试记录。恢复存储后刷新即可继续提交。');
        if (stored.command && stored.command.operationId !== settledOperation.current) {
          pendingRef.current = stored.command;
          setPending(stored.command);
        }
      }
    } catch (reason) {
      if (controller.signal.aborted || scope !== generation.current) return;
      setView(null);
      setError(reason instanceof Error ? reason.message : '读取失败，请重试。');
    } finally {
      if (!controller.signal.aborted && scope === generation.current) setLoading(false);
    }
  }, [reviewId, revokeAccess, install]);

  useEffect(() => {
    generation.current += 1;
    current.current = null;
    pendingRef.current = null;
    settledOperation.current = null;
    retryStorageAvailable.current = true;
    setView(null);
    setPending(null);
    setLoading(true);
    void refresh();
    const update = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const ownerUpdate = (event: Event) => {
      // Local projection invalidations also follow a save or access denial. Only the scoped server fact
      // requests another authority read; otherwise a denial would recursively invalidate itself.
      if (
        (event as CustomEvent<{ ownerUserId?: string }>).detail?.ownerUserId ===
          current.current?.review.task.ownerUserId &&
        current.current
      )
        update();
    };
    const accessRevoked = (event: Event) => {
      if ((event as CustomEvent<{ reviewId?: string }>).detail?.reviewId === reviewId) clearRevoked();
    };
    const interval = window.setInterval(update, 10_000);
    window.addEventListener('cat-cafe:artifact-review-changed', update);
    window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', ownerUpdate);
    window.addEventListener(REVIEW_ACCESS_REVOKED, accessRevoked);
    window.addEventListener('focus', update);
    return () => {
      generation.current += 1;
      controllerRef.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener('cat-cafe:artifact-review-changed', update);
      window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', ownerUpdate);
      window.removeEventListener(REVIEW_ACCESS_REVOKED, accessRevoked);
      window.removeEventListener('focus', update);
    };
  }, [refresh, reviewId, clearRevoked]);

  const send = useCallback(
    async (command: ArtifactReviewCommand): Promise<boolean> => {
      const latest = current.current;
      if (!latest || saving) return false;
      const scope = generation.current;
      const key = `${reviewDraftPrefix(latest.review.task.ownerUserId, reviewId)}pending`;
      try {
        localStorage.setItem(key, JSON.stringify(command));
      } catch {
        setError('浏览器暂时不能保存重试凭据，请先腾出存储空间。');
        return false;
      }
      pendingRef.current = command;
      setPending(command);
      setSaving(true);
      setError(null);
      try {
        const response = await apiFetch(`/api/artifact-reviews/${encodeURIComponent(reviewId)}/actions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(command),
        });
        const body = (await response.json()) as { view?: ArtifactReviewView; error?: string };
        if (scope !== generation.current) return false;
        if (!response.ok) {
          if ([400, 403, 404, 409, 410].includes(response.status)) {
            clearReviewRetryRecord(key);
            settledOperation.current = command.operationId;
            pendingRef.current = null;
            setPending(null);
          }
          if ([401, 404, 410].includes(response.status) || body.error === 'access_denied') revokeAccess();
          throw new Error(messages[body.error ?? ''] ?? '保存尚未完成，请核对后重试；草稿仍保留。');
        }
        if (scope !== generation.current || !body.view) return false;
        const retryCleared = clearReviewRetryRecord(key);
        settledOperation.current = command.operationId;
        pendingRef.current = null;
        setPending(null);
        install(body.view);
        clearCommittedReviewDraft(reviewDraftPrefix(latest.review.task.ownerUserId, reviewId), command);
        window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
        if (!retryCleared) setError('这次保存已确认，但浏览器未能清理本地重试记录。');
        return true;
      } catch (reason) {
        if (scope === generation.current)
          setError(reason instanceof Error ? reason.message : '保存结果尚未确认，请重试原操作。');
        return false;
      } finally {
        if (scope === generation.current) setSaving(false);
      }
    },
    [reviewId, saving, install, revokeAccess],
  );

  const act = useCallback(
    async (action: ArtifactReviewAction, round: number) => {
      const latest = current.current;
      if (!latest) return false;
      if (!retryStorageAvailable.current) {
        setError('浏览器暂时无法读取重试记录，恢复存储后请刷新再提交。');
        return false;
      }
      if (pendingRef.current) {
        setError('上一项保存结果还未确认，请先重试原操作。');
        return false;
      }
      return send({
        reviewId,
        expectedRevision: latest.review.revision,
        expectedTaskRevision: latest.authority.taskRevision,
        operationId: crypto.randomUUID(),
        round,
        action,
      });
    },
    [reviewId, send],
  );
  const retry = useCallback(() => (pendingRef.current ? send(pendingRef.current) : Promise.resolve(false)), [send]);
  return { view, loading, saving, error, pending, refresh, revokeAccess, act, retry };
}
