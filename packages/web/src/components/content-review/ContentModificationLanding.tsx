'use client';

import type { ContentModificationContextCatalogue, ContentModificationRequestView } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ContentModificationPanel } from './ContentModificationPanel';
import {
  modificationContextSelectionKey,
  restoreModificationContext,
  scopeModificationCatalogue,
} from './modification-context-selection';
import { modificationSourceVersion } from './modification-draft';
import { checked, json } from './modification-http';
import { isSettledModification } from './modification-polling';

type Props = Parameters<typeof ContentModificationPanel>[0] & { allowNewRequest?: boolean };
type Catalogue = ContentModificationContextCatalogue;

/** One in-place form, backed by real custody. Only genuine context ambiguity adds a chooser. */
export function ContentModificationLanding(props: Props) {
  const sourceKey = JSON.stringify(props.source);
  const [catalogueState, setCatalogue] = useState<{ key: string; value: Catalogue } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [newRequest, setNewRequest] = useState(false);
  const [draftAfterRequestId, setDraftAfterRequestId] = useState<string | null>(null);
  const [draftSourceVersion, setDraftSourceVersion] = useState<string | null>(null);
  const settledRecheck = useRef(new Set<string>());
  const taskRecheck = useRef(new Set<string>());
  const taskId = props.taskContext?.taskId;
  const selectionKey = modificationContextSelectionKey(props.ownerUserId, props.source, taskId);
  const readKey = `${sourceKey}:${selectionKey}:${props.initialRequest?.requestId ?? ''}`;
  const catalogue = catalogueState?.key === readKey ? catalogueState.value : null;
  const remember = (requestId: string | null, compose: boolean, fresh = false) => {
    try {
      const after = compose && !fresh ? requestId : null;
      const version = compose && !fresh ? modificationSourceVersion(props.source) : null;
      localStorage.setItem(
        selectionKey,
        JSON.stringify({
          v: 1,
          requestId,
          composing: compose,
          newRequest: fresh,
          ...(after ? { draftAfterRequestId: after } : {}),
          ...(version ? { draftSourceVersion: version } : {}),
        }),
      );
      setSelection(requestId);
      setComposing(compose);
      setNewRequest(fresh);
      setDraftAfterRequestId(after);
      setDraftSourceVersion(version);
      setError(null);
      return true;
    } catch {
      setError('暂时无法保存上下文选择，请恢复浏览器存储后重试。');
      return false;
    }
  };
  useEffect(() => {
    const abort = new AbortController();
    setCatalogue(null);
    setError(null);
    void apiFetch('/api/content-modifications/context', { ...json({ source: props.source }), signal: abort.signal })
      .then(checked<Catalogue>)
      .then((next) => {
        if (abort.signal.aborted) return;
        const scoped = scopeModificationCatalogue(next, taskId);
        const restored = restoreModificationContext(scoped, {
          ownerUserId: props.ownerUserId,
          source: props.source,
          taskId,
          requestId: props.initialRequest?.requestId,
        });
        setCatalogue({ key: readKey, value: scoped });
        setSelection(restored.requestId);
        setDraftAfterRequestId(restored.draftAfterRequestId ?? null);
        setDraftSourceVersion(restored.draftSourceVersion ?? null);
        const selectedContext = scoped.contexts.find((context) =>
          context.requestIds.includes(restored.requestId ?? ''),
        );
        const resumable =
          selectedContext?.state === 'active' && !!selectedContext.taskContext && props.allowNewRequest !== false;
        const freshAllowed = canStartNewFileRequest(
          props,
          scoped.requests.find((item) => item.record.requestId === restored.requestId),
          selectedContext,
        );
        const mayCompose = restored.newRequest ? freshAllowed : resumable;
        setNewRequest(restored.newRequest === true && freshAllowed);
        setComposing(restored.composing && mayCompose);
        if (restored.error) setError(restored.error);
        else if (restored.composing && !mayCompose) setError('原委托当前不可继续修改，未提交的草稿仍已保留。');
        else localStorage.setItem(selectionKey, JSON.stringify(restored));
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '暂时无法恢复原委托。');
      });
    return () => abort.abort();
    // Source fields, rather than allocation identity, determine the owner read.
    // biome-ignore lint/correctness/useExhaustiveDependencies: sourceKey is the complete immutable query
  }, [sourceKey, attempt, taskId, selectionKey, props.initialRequest?.requestId, readKey, props.allowNewRequest]);
  if (!catalogue)
    return (
      <aside className="border-t border-cafe-subtle p-3">
        {error ? (
          <>
            <p role="alert" className="text-sm text-cafe-error">
              {error}
            </p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-2 text-sm text-cafe-accent">
              重新读取委托
            </button>
          </>
        ) : (
          <p role="status" className="text-sm text-cafe-muted">
            正在恢复作品的修改上下文…
          </p>
        )}
      </aside>
    );
  const chosen = catalogue.requests.find((item) => item.record.requestId === selection);
  const context = catalogue.contexts.find((item) => item.requestIds.includes(selection ?? ''));
  const canStartNew = canStartNewFileRequest(props, chosen, context);
  const ambiguous = selection !== 'draft' && !chosen && (catalogue.requests.length > 0 || error !== null);
  const showForm = !ambiguous && (chosen || props.allowNewRequest !== false);
  return (
    <div className="min-h-0 shrink-0 overflow-auto">
      {error ? (
        <p role="alert" className="px-3 pt-2 text-sm text-cafe-error">
          {error}
        </p>
      ) : null}
      {catalogue.requests.length > 1 || ambiguous ? (
        <label className="block px-3 pt-3 text-xs text-cafe-muted">
          修改上下文与历史
          <select
            aria-label="作品修改上下文"
            value={selection ?? ''}
            onChange={(event) => {
              remember(event.target.value, false);
            }}
            className="mt-1 w-full rounded border border-cafe-subtle bg-cafe-surface p-2 text-cafe"
          >
            <option value="" disabled>
              请选择要继续的委托
            </option>
            {selection === 'draft' ? <option value="draft">尚未确认的原修改请求</option> : null}
            {catalogue.requests.map((item) => (
              <option key={item.record.requestId} value={item.record.requestId}>
                {requestLabel(item, catalogue)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {showForm ? (
        <ContentModificationPanel
          {...props}
          completionRule={context?.completionRule}
          contextKey={
            newRequest && composing
              ? `new:${chosen?.record.requestId}`
              : composing && context
                ? `task:${context.taskId}:${draftSourceVersion ?? modificationSourceVersion(props.source)}${draftAfterRequestId ? `:after:${draftAfterRequestId}` : ''}`
                : chosen?.record.requestId
          }
          initialRequest={composing ? undefined : chosen?.record}
          taskContext={
            newRequest
              ? undefined
              : context
                ? context.state === 'active'
                  ? context.taskContext
                  : undefined
                : props.taskContext
          }
          initialBody={newRequest ? chosen?.record.payload.intent.body : props.initialBody}
          onRequestKnown={(next) => {
            props.onRequestKnown?.(next);
            if (
              composing &&
              next.record.progress.task &&
              next.record.requestId !== selection &&
              remember(next.record.requestId, false)
            )
              setAttempt((value) => value + 1);
            else {
              const known = catalogue.requests.find((item) => item.record.requestId === next.record.requestId);
              const knownContext = catalogue.contexts.find((item) => item.requestIds.includes(next.record.requestId));
              if (
                known &&
                next.record.revision >= known.record.revision &&
                JSON.stringify(next.record.control) !== JSON.stringify(known.record.control)
              )
                setAttempt((value) => value + 1);
              // A request created after the catalogue was read gains its Task later; read the
              // catalogue once more so its context (continue / cancel scope) is known without a reload.
              else if (next.record.progress.task && !knownContext && !taskRecheck.current.has(next.record.requestId)) {
                taskRecheck.current.add(next.record.requestId);
                setAttempt((value) => value + 1);
              }
              // The Task can close after the cancellation was read; once the request has
              // settled, re-read the catalogue a single time so the next action appears.
              else if (
                isSettledModification(next) &&
                knownContext?.state !== 'closed' &&
                !settledRecheck.current.has(next.record.requestId)
              ) {
                settledRecheck.current.add(next.record.requestId);
                setAttempt((value) => value + 1);
              }
            }
          }}
          suggestedCatId={context?.targetCatId ?? catalogue.suggestedCatId ?? props.suggestedCatId}
          suggestedThreadId={context?.threadId ?? props.suggestedThreadId}
        />
      ) : (
        <p className="px-3 py-2 text-xs text-cafe-muted">
          {ambiguous ? '这件作品有多个真实修改上下文，请选择对应的委托。' : '当前版本只读；已有修改记录会在这里保留。'}
        </p>
      )}
      {canStartNew && !composing ? (
        <div className="px-3 pb-3">
          <p className="mb-2 text-xs text-cafe-muted">原委托已结束，历史保留。你可以针对当前文件重新确认修改。</p>
          <button
            type="button"
            data-testid="content-modification-new-request"
            className="text-sm text-cafe-accent"
            onClick={() => {
              if (remember(selection, true, true)) setAttempt((value) => value + 1);
            }}
          >
            发起新的修改请求
          </button>
        </div>
      ) : null}
      {chosen && context?.state === 'active' && !composing ? (
        <div className="px-3 pb-3">
          {context.taskContext && props.allowNewRequest !== false ? (
            <button
              type="button"
              data-testid="content-modification-continue"
              onClick={() => {
                if (remember(selection, true)) setAttempt((n) => n + 1);
              }}
              className="text-sm text-cafe-accent"
            >
              沿原委托继续修改
            </button>
          ) : context.publication ? (
            <button
              type="button"
              onClick={() => {
                const state = useChatStore.getState();
                if (context.publication)
                  state.openPublication(
                    { kind: 'publication', ...context.publication, title: props.title },
                    state.currentThreadId,
                  );
              }}
              className="text-sm text-cafe-accent"
            >
              打开原委托的当前作品
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function canStartNewFileRequest(
  props: Props,
  chosen: ContentModificationRequestView | undefined,
  context: Catalogue['contexts'][number] | undefined,
) {
  return (
    props.allowNewRequest !== false &&
    props.source.kind === 'workspace' &&
    chosen?.record.control?.taskResolution === 'closed' &&
    context?.state === 'closed'
  );
}

function requestLabel(item: ContentModificationRequestView, catalogue: Catalogue) {
  const context = catalogue.contexts.find((entry) => entry.requestIds.includes(item.record.requestId));
  return `${context ? `${context.targetName} · ${context.threadTitle}` : '尚未接责的修改请求'} · ${item.record.payload.intent.body.slice(0, 60) || '图片修改'} · ${new Date(item.record.createdAt).toLocaleString()}`;
}
