'use client';
import {
  type ContentModificationChoices,
  type ContentModificationDetailView,
  type ContentModificationRecord,
  type ContentModificationRequest,
  type ContentModificationRequestView,
  contentModificationOutcome,
  contentModificationRequestSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { acceptContentResult } from './accept-content-result';
import { withDistinctCatNames } from './modification-choices';
import {
  type ModificationDraft,
  modificationSourceVersion,
  modificationStorageKey,
  readModificationDraft,
  saveModificationDraft,
} from './modification-draft';
import { rebaseModificationDraft } from './modification-draft-scope';
import { checked, json, ModificationHttpError } from './modification-http';
import { isSettledModification } from './modification-polling';
import { olderModificationRead } from './modification-read-order';

export function useContentModification(input: {
  source: ContentModificationRequest['source'];
  ownerUserId: string;
  suggestedCatId?: string;
  suggestedThreadId?: string;
  initialRequest?: ContentModificationRecord;
  taskContext?: ContentModificationRequest['taskContext'];
  contextKey?: string;
  initialIntent?: Omit<ContentModificationRequest['intent'], 'body'>;
  initialIntentSourceVersion?: string;
  initialBody?: string;
  onApplied?: (writtenRevision?: string) => Promise<void> | void;
}) {
  const key =
    modificationStorageKey(input.ownerUserId, input.source) + (input.contextKey ? `:${input.contextKey}` : '');
  const initialIntent = input.initialRequest
    ? {
        ...(input.initialRequest.payload.intent.imageEdit
          ? { imageEdit: input.initialRequest.payload.intent.imageEdit }
          : {}),
        ...(input.initialRequest.payload.intent.selection
          ? { selection: input.initialRequest.payload.intent.selection }
          : {}),
      }
    : input.initialIntent;
  const [draft, setDraft] = useState<ModificationDraft>({
    v: 1,
    sourceVersion: modificationSourceVersion(input.initialRequest?.payload.source ?? input.source),
    body: input.initialRequest?.payload.intent.body ?? input.initialBody ?? '',
    targetCatId: input.initialRequest?.payload.targetCatId ?? input.suggestedCatId ?? '',
    threadId: input.initialRequest?.payload.threadId ?? input.suggestedThreadId ?? '',
    ...(input.initialRequest
      ? { operation: input.initialRequest.payload, requestId: input.initialRequest.requestId }
      : {}),
    ...(initialIntent ? { intent: initialIntent } : {}),
    acceptOperations: {},
  });
  const current = useRef(draft);
  const [ready, setReady] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<ContentModificationChoices | null>(null);
  const [view, setView] = useState<ContentModificationDetailView | null>(null);
  const [sent, setSent] = useState<ContentModificationRequestView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  useEffect(() => {
    try {
      const prior = readModificationDraft(key);
      if (prior) {
        if (!prior.operation && input.taskContext) {
          prior.targetCatId = input.suggestedCatId ?? '';
          prior.threadId = input.suggestedThreadId ?? '';
        }
        current.current = prior;
        setDraft(prior);
      }
      setReady(true);
    } catch {
      setError('暂时无法读取原位草稿。请恢复浏览器存储后重试。');
    }
  }, [key, input.taskContext, input.suggestedCatId, input.suggestedThreadId]);
  useEffect(() => {
    let active = true;
    void apiFetch('/api/content-modifications/choices')
      .then((response) => checked<ContentModificationChoices>(response))
      .then((next) => {
        if (active) setChoices(withDistinctCatNames(next));
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const save = useCallback(
    (next: ModificationDraft) => {
      try {
        saveModificationDraft(key, next);
        current.current = next;
        setDraft(next);
        return true;
      } catch {
        setError('暂时无法保存重试记录；修改尚未提交。请恢复浏览器存储。');
        return false;
      }
    },
    [key],
  );
  const edit = (patch: Partial<Pick<ModificationDraft, 'body' | 'targetCatId' | 'threadId' | 'intent'>>) => {
    if (current.current.operation) return;
    if (input.taskContext && (patch.targetCatId !== undefined || patch.threadId !== undefined)) return;
    save({ ...current.current, ...patch });
  };
  useEffect(() => {
    if (!view) return;
    const before = current.current.rejectionPending ?? [];
    const rejectionPending = before.filter(
      (ref) =>
        !view.record.control &&
        !view.rejections?.some((item) => item.candidateRef === ref) &&
        !view.acceptances.some((item) => item.acceptance.candidateRef === ref),
    );
    if ((view.record.control && current.current.cancellationPending) || before.length !== rejectionPending.length) {
      save({ ...current.current, rejectionPending, ...(view.record.control ? { cancellationPending: false } : {}) });
      setError(null);
    }
  }, [view, save]);
  useEffect(() => {
    if (!ready || draft.requestId || !draft.operation) return;
    let active = true;
    const operationId = draft.operation.operationId;
    const lookup = async () => {
      try {
        const response = await apiFetch(`/api/content-modifications/by-operation/${encodeURIComponent(operationId)}`);
        // Not found during an in-flight POST is unknown, not proof that no request will be committed.
        if (response.status === 404) return;
        const next = await checked<ContentModificationRequestView>(response);
        if (active && current.current.operation?.operationId === operationId) {
          save({ ...current.current, requestId: next.record.requestId });
          setSent(next);
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : '正在核对原提交。');
      }
    };
    void lookup();
    const timer = setInterval(() => void lookup(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready, draft.requestId, draft.operation, save]);
  const refresh = useCallback(async (requestId: string) => {
    try {
      const response = await apiFetch(`/api/content-modifications/${encodeURIComponent(requestId)}`, undefined, {
        afterCurrentGet: true,
      });
      const next = await checked<ContentModificationDetailView>(response);
      setView((prior) => (olderModificationRead(prior, next) ? prior : next));
      setReadError(null);
      return next;
    } catch (error) {
      if (error instanceof ModificationHttpError && [401, 403, 404, 410].includes(error.status)) setView(null);
      setReadError(error instanceof Error ? error.message : '暂时无法读取原请求。');
      throw error;
    }
  }, []);
  useEffect(() => {
    if (!ready || !draft.requestId) return;
    const id = draft.requestId;
    const read = () =>
      void refresh(id)
        .then((next) => {
          // Settled requests have nothing left to change; keep the last view, stop reading.
          if (isSettledModification(next)) clearInterval(timer);
        })
        .catch(() => undefined);
    const timer = setInterval(read, 4000);
    read();
    return () => clearInterval(timer);
  }, [draft.requestId, ready, refresh]);
  const sourceChanged = draft.sourceVersion !== modificationSourceVersion(input.source);
  const rebased = rebaseModificationDraft(draft, input.source, {
    intent: input.initialIntent,
    sourceVersion: input.initialIntentSourceVersion,
  });
  const target = choices?.cats.find((cat) => cat.catId === draft.targetCatId);
  const thread = choices?.threads.find((thread) => thread.threadId === draft.threadId);
  const blocked = Boolean(
    choices && draft.targetCatId && (!target || target.preflight?.disposition === 'rejected' || !target.mcpSupport),
  );
  const submit = async () => {
    if (!ready || busy || submitting || (!draft.operation && (sourceChanged || !target || !thread || blocked))) return;
    setSubmitting(true);
    setError(null);
    try {
      const prior = current.current;
      const operation =
        prior.operation ??
        contentModificationRequestSchema.parse({
          operationId: crypto.randomUUID(),
          source: input.source,
          targetCatId: prior.targetCatId,
          threadId: prior.threadId,
          intent: { body: prior.body, ...prior.intent },
          ...(input.taskContext ? { taskContext: input.taskContext } : {}),
        });
      contentModificationOutcome(operation.intent);
      if (!save({ ...prior, operation })) return;
      const next = await checked<ContentModificationRequestView>(
        await apiFetch('/api/content-modifications', json(operation)),
      );
      save({ ...current.current, requestId: next.record.requestId });
      setSent((prior) => (olderModificationRead(prior, next) ? prior : next));
      await refresh(next.record.requestId);
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    } catch (error) {
      setError(error instanceof Error ? error.message : '提交结果未确认，请重试原操作。');
    } finally {
      setSubmitting(false);
    }
  };
  const accept = async (candidateRef: string) => {
    if (!ready || busy || submitting || !view || current.current.cancellationPending) return;
    const fileSource = view.writeback
      ? { locator: view.writeback.locator, expectedSourceRevision: view.writeback.baseRevision }
      : view.record.payload.source.kind === 'workspace'
        ? view.record.payload.source
        : null;
    if (!fileSource) return;
    setBusy(true);
    setError(null);
    try {
      const requestId = view.record.requestId;
      const acceptOperationId = current.current.acceptOperations[candidateRef] ?? crypto.randomUUID();
      const baseRevision = current.current.acceptBases?.[candidateRef] ?? fileSource.expectedSourceRevision;
      if (
        !save({
          ...current.current,
          acceptOperations: { ...current.current.acceptOperations, [candidateRef]: acceptOperationId },
          acceptBases: { ...current.current.acceptBases, [candidateRef]: baseRevision },
        })
      )
        return;
      const accepted = await acceptContentResult(
        {
          requestId,
          candidateRef,
          acceptOperationId,
          source: { ...fileSource, expectedSourceRevision: baseRevision },
        },
        refresh,
      );
      if (accepted) await input.onApplied?.(accepted.writtenRevision);
    } catch (error) {
      setError(error instanceof Error ? error.message : '写回结果未确认。候选已保留，请核对原操作。');
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const requestId = current.current.requestId;
    if (!ready || busy || !requestId) return;
    if (!save({ ...current.current, cancellationPending: true })) return;
    setBusy(true);
    setError(null);
    try {
      const next = await checked<ContentModificationRequestView>(
        await apiFetch(`/api/content-modifications/${encodeURIComponent(requestId)}/cancel`, json({})),
      );
      setSent(next);
      setView((prior) =>
        prior
          ? { ...prior, ...next, ...(prior.writeback ? { writeback: { ...prior.writeback, writable: false } } : {}) }
          : null,
      );
      save({ ...current.current, cancellationPending: false });
      await refresh(requestId);
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    } catch {
      setError('取消结果尚未确认。请求和候选已保留；重试会核对同一次取消。');
    } finally {
      setBusy(false);
    }
  };
  const reject = async (candidateRef: string) => {
    const requestId = current.current.requestId;
    if (!ready || busy || submitting || !requestId) return;
    if (
      !save({
        ...current.current,
        rejectionPending: [...new Set([...(current.current.rejectionPending ?? []), candidateRef])],
      })
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await checked(
        await apiFetch(`/api/content-modifications/${encodeURIComponent(requestId)}/reject`, json({ candidateRef })),
      );
      await refresh(requestId);
    } catch (error) {
      setError(
        error instanceof ModificationHttpError ? error.message : '拒绝结果尚未确认。候选已保留，请核对并重试原决定。',
      );
      await refresh(requestId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return {
    draft,
    choices,
    view,
    sent,
    ready,
    busy: busy || submitting,
    cancelDisabled: busy || !ready,
    error: error ?? readError,
    target,
    thread,
    blocked,
    destinationLocked: Boolean(input.taskContext),
    sourceChanged,
    canUseCurrentSource: Boolean(rebased),
    useCurrentSource: () => {
      const next = rebaseModificationDraft(current.current, input.source, {
        intent: input.initialIntent,
        sourceVersion: input.initialIntentSourceVersion,
      });
      if (ready && !busy && !submitting && next && save(next)) setError(null);
    },
    edit,
    submit,
    accept,
    cancel,
    reject,
    refresh: () => (draft.requestId ? refresh(draft.requestId) : Promise.resolve(null)),
  };
}

export type ContentModificationModel = ReturnType<typeof useContentModification>;
