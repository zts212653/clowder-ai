'use client';
import type { EvolutionMediaLocator, WorkspaceContentReviewAction, WorkspaceContentReviewView } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { checked, ModificationHttpError } from '@/components/content-review/modification-http';
import { clearCommittedDraft } from '@/components/content-review/review-draft-commit';
import { apiFetch } from '@/utils/api-client';
import { useWorkspaceReviewOwnerUpdates } from './useWorkspaceReviewOwnerUpdates';
import {
  preparePendingAction,
  readWorkspaceOperationReceipt,
  reconcileActionFailure,
} from './workspace-review-action-recovery';
import { useWorkspaceReviewDraft, type WorkspaceAnnotationTarget } from './workspace-review-draft';
import { useLegacyTextNotes } from './workspace-review-legacy-text';

export type { WorkspaceAnnotationTarget } from './workspace-review-draft';

/** Owner refusals that describe the file itself; opening ends there instead of looking like it still loads. */
const SOURCE_REFUSALS: Record<string, string> = {
  unsupported_media: '这个文件的实际内容不是可协作的图片或视频格式（后缀可能与内容不符），无法打开作品现场。',
  unsupported_text: '这个文件不是可协作的文本格式，无法打开作品现场。',
  too_large: '这个文件超出了作品现场可打开的大小。',
};

function openFailureMessage(error: unknown): string {
  return (error instanceof ModificationHttpError && SOURCE_REFUSALS[error.code]) || '内容 owner 当前无法建立协作入口。';
}

type Target =
  | { worktreeId: string; path: string; publication?: never; evolution?: never }
  | { publication: { contentRef: string; ownerRevision: number }; worktreeId?: never; path?: never; evolution?: never }
  | { evolution: EvolutionMediaLocator; worktreeId?: never; path?: never; publication?: never };

export function useWorkspaceContentReview({ worktreeId, path, publication, evolution }: Target) {
  const contentRef = publication?.contentRef,
    ownerRevision = publication?.ownerRevision;
  const evolutionKey = evolution ? JSON.stringify(evolution) : undefined;
  const base = publication || evolution ? '/api/content-reviews' : '/api/workspace/content-reviews';
  const [view, setView] = useState<WorkspaceContentReviewView | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const state = useWorkspaceReviewDraft();
  const { activate, reset, confirmAnnotation } = state;
  const generation = useRef(0),
    prepareOperationId = useRef<string | null>(null);
  const readSequence = useRef(0);

  const load = useCallback(
    async (reviewId?: string) => {
      const stamp = generation.current;
      const readTicket = ++readSequence.current;
      const operationId = reviewId ? null : (prepareOperationId.current ?? crypto.randomUUID());
      if (operationId) prepareOperationId.current = operationId;
      const response = reviewId
        ? await apiFetch(`${base}/${encodeURIComponent(reviewId)}`)
        : await apiFetch(`${base}/prepare`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              evolutionKey
                ? { evolution: JSON.parse(evolutionKey), operationId }
                : contentRef
                  ? { publication: { contentRef, ownerRevision }, operationId }
                  : { locator: { worktreeId, path }, operationId },
            ),
          });
      if (stamp !== generation.current || readTicket !== readSequence.current) throw new Error('obsolete_content_read');
      if (!response.ok) {
        if ([401, 403, 404, 410].includes(response.status)) {
          setView(null);
          reset();
        }
        // Throws a ModificationHttpError carrying the owner's typed code.
        await checked<unknown>(response);
      }
      const next = (await response.json()) as WorkspaceContentReviewView;
      if (stamp !== generation.current || readTicket !== readSequence.current) throw new Error('obsolete_content_read');
      if (operationId) prepareOperationId.current = null;
      activate(next);
      for (const annotation of next.review.annotations)
        if (annotation.operationId) confirmAnnotation(annotation.operationId);
      setView(next);
      setError(null);
      return next;
    },
    [base, path, worktreeId, contentRef, ownerRevision, evolutionKey, activate, confirmAnnotation, reset],
  );

  useEffect(() => {
    const stamp = ++generation.current;
    setView(null);
    setError(null);
    setBusy(false);
    reset();
    prepareOperationId.current = null;
    void load().catch((failure) => {
      if (stamp === generation.current) setError(openFailureMessage(failure));
    });
    return () => {
      generation.current++;
    };
  }, [load, reset]);
  useWorkspaceReviewOwnerUpdates(view?.review.reviewId ?? null, load, setError);
  const legacyText = useLegacyTextNotes({ view, draft: state, load, base });

  const submitAnnotation = async () => {
    const draft = state.current.current;
    if (!view || busy || (!draft.annotation && (!draft.target || !draft.body.trim()))) return;
    // Text annotations are no longer written from here (CVO095/098): new ones go to chat, old ones are only reconciled.
    if ((draft.annotation?.target ?? draft.target)?.kind === 'text_quote') return;
    const request = draft.annotation ?? {
      operationId: crypto.randomUUID(),
      expectedRevision: view.review.revision,
      body: draft.body.trim(),
      target: draft.target!,
    };
    if (!state.save({ annotation: request })) return;
    const stamp = generation.current;
    setBusy(true);
    setError(null);
    let confirmedRejection = false;
    try {
      const response = await apiFetch(`${base}/${encodeURIComponent(view.review.reviewId)}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (stamp !== generation.current) return;
      if (!response.ok) {
        confirmedRejection = response.status >= 400 && response.status < 500;
        throw new Error(await response.text());
      }
      confirmAnnotation(request.operationId);
      await load(view.review.reviewId);
    } catch {
      if (stamp !== generation.current) return;
      const refreshed = await load(view.review.reviewId).catch(() => undefined);
      if (stamp !== generation.current) return;
      if (refreshed?.review.annotations.some((annotation) => annotation.operationId === request.operationId)) {
        confirmAnnotation(request.operationId);
        setError('批注已从操作记录确认保存。');
      } else {
        const receipt = await readWorkspaceOperationReceipt(base, view.review.reviewId, request.operationId);
        if (stamp !== generation.current) return;
        if (
          receipt &&
          refreshed &&
          receipt.actor.kind === 'human' &&
          receipt.actor.actorId === refreshed.review.ownerUserId
        ) {
          confirmAnnotation(request.operationId);
          setError('批注已从操作回执确认保存。');
        } else if (receipt === null && confirmedRejection) {
          state.save({ annotation: null });
          setError('本次批注尚未保存。草稿已保留，请核对当前内容后重新提交。');
        } else setError('保存结果暂未确认：请重试同一条批注，系统会按原操作号对账。');
      }
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  const refreshSource = async (options?: { readonly expectedSourceRevision?: string }) => {
    if (!view || busy) return;
    if (publication) {
      try {
        await load(view.review.reviewId);
      } catch {
        setError('暂时无法重新读取作品，原草稿保留。');
      }
      return;
    }
    // An unfinished earlier refresh is replayed as-is (same operation, same fence) for idempotency.
    const pending = state.current.current.refresh ?? {
      operationId: crypto.randomUUID(),
      expectedRevision: view.review.revision,
      ...(options?.expectedSourceRevision ? { expectedSourceRevision: options.expectedSourceRevision } : {}),
    };
    if (!state.save({ refresh: pending })) return;
    const stamp = generation.current;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`${base}/${encodeURIComponent(view.review.reviewId)}/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pending),
      });
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as WorkspaceContentReviewView;
      if (stamp !== generation.current) return;
      state.save({ refresh: null });
      activate(next);
      setView(next);
    } catch {
      if (stamp === generation.current) setError('无法切换到当前内容版本。原版草稿仍然保留。');
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };

  const act = async (action: WorkspaceContentReviewAction): Promise<boolean> => {
    if (!view || busy) return false;
    const pending = preparePendingAction(state.current.current.action, action, view.review.revision);
    if (!pending) {
      setError('前一个保存结果尚未确认，请先重试原操作。当前草稿仍然保留。');
      return false;
    }
    if (!state.save({ action: pending })) return false;
    const stamp = generation.current;
    setBusy(true);
    setError(null);
    let confirmedRejection = false;
    try {
      const response = await apiFetch(`${base}/${encodeURIComponent(view.review.reviewId)}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: pending.expectedRevision,
          operationId: pending.operationId,
          action: pending.action,
        }),
      });
      if (stamp !== generation.current) return false;
      if (!response.ok) {
        confirmedRejection = response.status >= 400 && response.status < 500;
        throw new Error(await response.text());
      }
      await load(view.review.reviewId);
      if (stamp !== generation.current) return false;
      state.save({ action: null });
      confirmReply(view.review.reviewId, pending.action);
      return true;
    } catch {
      if (stamp !== generation.current) return false;
      const recovery = await reconcileActionFailure(load, view.review.reviewId, pending, confirmedRejection, base);
      if (stamp !== generation.current) return false;
      if (recovery === 'confirmed') {
        state.save({ action: null });
        confirmReply(view.review.reviewId, pending.action);
        setError('协作操作已从最新状态确认保存。');
        return true;
      }
      if (recovery === 'discard') state.save({ action: null });
      setError('协作操作结果暂未确认：请重试同一动作，系统会按原操作号对账。');
      return false;
    } finally {
      if (stamp === generation.current) setBusy(false);
    }
  };
  const retryPending = async () => {
    const saved = state.current.current;
    if (saved.annotation && saved.annotation.target.kind !== 'text_quote') await submitAnnotation();
    else if (saved.action) await act(saved.action.action);
    else if (saved.refresh) await refreshSource();
  };
  return {
    view,
    error: state.storageError ? '浏览器暂时无法保存草稿或重试记录。请恢复存储后重试；当前输入仍保留。' : error,
    draft: state.snapshot.body,
    target: state.snapshot.target,
    activeAnnotationId: state.snapshot.activeAnnotationId,
    busy,
    pending: Boolean(
      (state.snapshot.annotation && state.snapshot.annotation.target.kind !== 'text_quote') ||
        state.snapshot.action ||
        state.snapshot.refresh,
    ),
    legacyText,
    retryPending,
    setDraft: (body: string) => {
      state.save({ body });
    },
    setTarget: (target: WorkspaceAnnotationTarget | null) => {
      state.save({ target });
    },
    setActiveAnnotationId: (activeAnnotationId: string | null) => {
      state.save({ activeAnnotationId });
    },
    submitAnnotation,
    refreshSource,
    act,
  };
}

function confirmReply(reviewId: string, action: WorkspaceContentReviewAction) {
  if (action.kind === 'reply')
    clearCommittedDraft(`workspace-content-review:${reviewId}:reply:${action.annotationId}`, action.body);
}
