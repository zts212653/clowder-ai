import {
  assertCollectiveMediaReceipt,
  assertCollectiveMediaView,
  type CollectiveMediaReviewCommand,
  type CollectiveMediaSurfaceRefV1,
  type CollectiveMediaView,
  type WorkspaceContentReviewAction,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearCommittedDraft } from '@/components/content-review/review-draft-commit';
import type { ContentReviewController } from '@/components/workbench/content-review/content-review-contract';
import { type MediaDraft, mediaDraftKey } from './collective-media-draft';
import { appendMediaPage, nextMediaPage } from './collective-media-pages';
import { useCollectiveMediaDraft } from './use-collective-media-draft';
import {
  type CollectiveMediaRpc,
  CollectiveMediaRpcError,
  collectiveMediaErrorMessage,
} from './use-collective-media-rpc';

export function useCollectiveMediaReview(ref: CollectiveMediaSurfaceRefV1, rpc: CollectiveMediaRpc) {
  const key = mediaDraftKey(ref);
  const [value, setValue] = useState<CollectiveMediaView & { title?: string; actors?: Record<string, string> }>();
  const latest = useRef(value);
  latest.current = value;
  const [error, setError] = useState<string | null>(null);
  const drafts = useCollectiveMediaDraft(key),
    { draft, current: currentDraft, save } = drafts;
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false),
    generation = useRef(0);
  const reading = useRef(false),
    readSequence = useRef(0);
  const fail = useCallback((failure: unknown) => {
    // Pixels and owner metadata close on every failed fresh read; own unsent words stay in their scoped draft.
    setValue(undefined);
    setError(collectiveMediaErrorMessage(failure));
  }, []);
  const read = useCallback(
    async (page = {}) => {
      const result = await rpc({
        kind: 'read',
        page: {
          annotationOffset: 0,
          annotationLimit: 2,
          replyOffset: 0,
          requestOffset: 0,
          requestLimit: 30,
          cursor: 0,
          ...page,
        },
      });
      if (result.kind !== 'read') throw new Error('MEDIA_READ_MISMATCH');
      return {
        ...assertCollectiveMediaView(result.value, { ...result.value, ...ref }),
        title: result.title,
        actors: Object.fromEntries((result.actors ?? []).map((actor) => [actor.humanId, actor.displayName])),
      };
    },
    [rpc, ref],
  );
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const sequence = ++readSequence.current;
    const visit = generation.current;
    try {
      const next = await read();
      if (visit !== generation.current || sequence !== readSequence.current) return;
      setValue((previous) =>
        previous?.view.review.revision === next.view.review.revision
          ? {
              ...previous,
              actors: { ...previous.actors, ...next.actors },
              view: {
                ...previous.view,
                canWrite: next.view.canWrite,
                canReply: next.view.canReply,
                historyReadOnly: next.view.historyReadOnly,
                sourceState: next.view.sourceState,
              },
            }
          : next,
      );
      setError(null);
    } catch (failure) {
      if (visit === generation.current && sequence === readSequence.current) fail(failure);
    } finally {
      reading.current = false;
    }
  }, [read, fail]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!writing.current) void refresh();
    }, 3000);
    return () => {
      ++generation.current;
      clearInterval(timer);
    };
  }, [refresh]);
  const send = async (pending: NonNullable<MediaDraft['pending']>) => {
    const selected = latest.current;
    if (!selected || writing.current) return false;
    writing.current = true;
    ++readSequence.current;
    setBusy(true);
    const visit = generation.current;
    try {
      const result = await rpc({ kind: 'annotate', ...pending });
      if (result.kind !== 'annotated') throw new Error('批注回执尚未核对，请重试原操作。');
      await assertCollectiveMediaReceipt(result.value, ref, pending.operationId, selected.view.review.reviewId);
      drafts.settle(pending, 'committed');
      const action = pending.command.action;
      if (action.kind === 'reply') clearCommittedDraft(`${key}:reply:${action.annotationId}`, action.body);
      if (action.kind === 'edit_annotation' || action.kind === 'edit_reply')
        clearCommittedDraft(
          `${key}:edit:${action.annotationId}${action.kind === 'edit_reply' ? `:${action.replyId}` : ''}`,
          action.body,
        );
      if (visit === generation.current) {
        await refresh();
      }
      return true;
    } catch (failure) {
      if (failure instanceof CollectiveMediaRpcError && failure.code === 'conflict') {
        drafts.settle(pending, 'conflict');
      }
      if (visit === generation.current) fail(failure);
      return false;
    } finally {
      writing.current = false;
      if (visit === generation.current) setBusy(false);
    }
  };
  const act = async (action: CollectiveMediaReviewCommand['action']) => {
    const selected = latest.current;
    if (!selected) return false;
    const pending = currentDraft.current.pending;
    if (pending) {
      setError('先核对上一次保存结果；新输入仍保留。');
      return false;
    }
    const command: NonNullable<MediaDraft['pending']> = {
      operationId: crypto.randomUUID(),
      command: { kind: 'media-review', expectedReviewRevision: selected.view.review.revision, action },
    };
    if (!save({ ...currentDraft.current, pending: command })) return false;
    return send(command);
  };
  const more = async (annotationId?: string) => {
    const selected = latest.current;
    if (!selected || writing.current || reading.current) return;
    const options = nextMediaPage(selected, annotationId);
    if (!options) return;
    const visit = generation.current;
    const sequence = ++readSequence.current;
    reading.current = true;
    setBusy(true);
    try {
      const page = await read(options);
      if (visit === generation.current && sequence === readSequence.current)
        setValue({
          ...appendMediaPage(selected, page, annotationId),
          title: selected.title,
          actors: { ...selected.actors, ...page.actors },
        });
    } catch (failure) {
      if (visit === generation.current && sequence === readSequence.current) fail(failure);
    } finally {
      reading.current = false;
      if (visit === generation.current && !writing.current) setBusy(false);
    }
  };
  const controller: ContentReviewController = {
    // The canvas renders the explicitly selected immutable version. The canonical ledger's head/revision stays intact.
    view: value
      ? { ...value.view, review: { ...value.view.review, source: value.view.currentSource }, sourceState: 'current' }
      : null,
    error: drafts.error ? '草稿未能保存；输入仍保留，请恢复浏览器存储后重试。' : error,
    draft: draft.body,
    target: draft.anchor ? { kind: 'media_anchor', anchor: draft.anchor } : null,
    activeAnnotationId: active,
    busy,
    pending: Boolean(draft.pending),
    setDraft: (body) => drafts.update({ body }),
    setTarget: (target) => {
      if (!target || target.kind === 'media_anchor') drafts.update({ anchor: target?.anchor ?? null });
    },
    setActiveAnnotationId: setActive,
    submitAnnotation: async () => {
      const current = currentDraft.current;
      if (current.anchor && current.body.trim())
        await act({ kind: 'annotate', anchor: current.anchor, body: current.body.trim() });
    },
    refreshSource: refresh,
    act: async (action: WorkspaceContentReviewAction) =>
      action.kind === 'reply'
        ? act({ kind: 'reply', annotationId: action.annotationId, body: action.body })
        : action.kind === 'set_annotation_state'
          ? act(action)
          : false,
    retryPending: async () => {
      if (currentDraft.current.pending) await send(currentDraft.current.pending);
    },
  };
  return { controller, value, key, act, more };
}
