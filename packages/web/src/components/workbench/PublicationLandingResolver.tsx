'use client';
import type { PublicationReviewContext } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { checked, json } from '@/components/content-review/modification-http';
import { apiFetch } from '@/utils/api-client';
import { createArtifactReviewSurface } from './artifact-review-surface';
import {
  publicationContextCatalogueSchema as catalogueSchema,
  contentContextSelectionKey,
  continueReviewLabel,
  publicationContextLabel,
} from './publication-context';
import { createPublicationSurface, type PublicationTarget } from './publication-surface';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export { contentContextSelectionKey } from './publication-context';
export function publicationContextSurface(
  target: PublicationTarget,
  title: string,
  context?: PublicationReviewContext,
): WorkspaceSurfaceDescriptor {
  return context
    ? createArtifactReviewSurface(context.reviewId, context.threadId, title, context.round)
    : createPublicationSurface({ ...target, title });
}

/** Resolving shells never mount a second editor. F307 consumes the verified final identity first. */
export function PublicationLandingResolver({
  sourceSurface,
  target,
  onResolved,
  children,
  onBack,
  confirmSingleContext: confirmOverride,
}: {
  sourceSurface: WorkspaceSurfaceDescriptor;
  target: PublicationTarget;
  onResolved: (surface: WorkspaceSurfaceDescriptor) => void;
  children: ReactNode;
  onBack: () => void;
  /**
   * F309 parent 135: a generic entry shows even a single review as a named action to continue.
   * Defaults to whether the surface was opened from a chat message; hosts that know better override.
   */
  confirmSingleContext?: boolean;
}) {
  const confirmSingleContext = confirmOverride ?? Boolean(sourceSurface.messagePublicationSource);
  const [storedCatalogue, setCatalogue] = useState<(z.infer<typeof catalogueSchema> & { targetKey: string }) | null>(
    null,
  );
  const [selection, setSelection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const callback = useRef(onResolved);
  callback.current = onResolved;
  // F309 parent 102: once the work itself is on screen, a review that appears later is offered
  // beside it; it neither takes the work away nor is entered on its own.
  const showingWork = useRef<string | null>(null);
  const { contentRef, ownerRevision } = target;
  const targetKey = JSON.stringify([contentRef, ownerRevision]);
  const catalogue = storedCatalogue?.targetKey === targetKey ? storedCatalogue : null;
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
    void apiFetch('/api/content-reviews/resolve', { ...json({ contentRef, ownerRevision }), signal: abort.signal })
      .then(checked<unknown>)
      .then((value) => {
        const result = catalogueSchema.parse(value);
        if (abort.signal.aborted) return;
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(contentContextSelectionKey(result.ownerUserId, contentRef));
        } catch {
          setError('浏览器暂时无法保留上下文选择，本次仍可继续打开。');
        }
        const workOnScreen = showingWork.current === JSON.stringify([contentRef, ownerRevision]);
        const only = result.contexts.length === 1 ? result.contexts[0] : undefined;
        // A review on the work's own canonical ledger (ledgerRef) is the same discussion: Step1 keeps
        // entering it. Only an independent Task review is continued by name from a generic entry.
        const enterOnly = only && !(confirmSingleContext && !only.ledgerRef) && !workOnScreen;
        const next = saved
          ? result.contexts.some((item) => item.reviewId === saved)
            ? saved
            : null
          : enterOnly
            ? only.reviewId
            : null;
        if (saved && !next && result.contexts.length) setError('上次选择的讨论当前不可用，请明确选择要继续的委托。');
        if (next)
          try {
            localStorage.setItem(contentContextSelectionKey(result.ownerUserId, contentRef), next);
          } catch {
            setError('选择尚未保存到浏览器，请保留页面。');
          }
        setSelection(next);
        setCatalogue({ ...result, targetKey: JSON.stringify([contentRef, ownerRevision]) });
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setCatalogue(null);
          setError(failure instanceof Error ? failure.message : '暂时无法核对原讨论。');
        }
      });
    return () => abort.abort();
  }, [contentRef, ownerRevision, attempt, confirmSingleContext]);
  const chosen = catalogue?.contexts.find((item) => item.reviewId === selection);
  const resolved =
    catalogue && (catalogue.contexts.length === 0 || chosen)
      ? publicationContextSurface({ contentRef, ownerRevision }, sourceSurface.title, chosen)
      : null;
  const resolvedKey = resolved ? JSON.stringify(resolved) : null;
  useEffect(() => {
    if (!resolvedKey) return;
    const target = JSON.parse(resolvedKey) as WorkspaceSurfaceDescriptor;
    if (target.id !== sourceSurface.id) callback.current(target);
    else showingWork.current = targetKey;
  }, [resolvedKey, sourceSurface.id, targetKey]);
  const choose = (id: string) => {
    if (!catalogue?.contexts.some((item) => item.reviewId === id)) return;
    try {
      localStorage.setItem(contentContextSelectionKey(catalogue.ownerUserId, contentRef), id);
    } catch {
      setError('选择尚未保存到浏览器，请保留页面。');
    }
    setSelection(id);
  };
  const besideWork = reviewsBesideWork(catalogue, chosen, showingWork.current === targetKey);
  if (resolved?.id === sourceSurface.id || besideWork)
    return (
      <WorkInPlace contexts={besideWork} onChoose={choose}>
        {children}
      </WorkInPlace>
    );
  return (
    <section className="p-4">
      <button type="button" className="mb-3 text-xs text-cafe-muted" onClick={onBack}>
        返回来源
      </button>
      <h2 className="text-sm font-semibold">{sourceSurface.title}</h2>
      {error ? (
        <p role="alert" className="my-2 text-sm text-cafe-error">
          {error}
        </p>
      ) : null}
      {!catalogue ? (
        <>
          <p role="status" className="text-xs text-cafe-muted">
            正在核对作品的原讨论…
          </p>
          {error ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              重新读取
            </button>
          ) : null}
        </>
      ) : resolved ? (
        <p role="status">正在回到原作品…</p>
      ) : (
        <ContextChoice contexts={catalogue.contexts} selection={selection} onChoose={choose} />
      )}
    </section>
  );
}

/** Reviews that appeared while the work was on screen and were not chosen; null when none. */
function reviewsBesideWork(
  catalogue: { contexts: readonly PublicationReviewContext[] } | null,
  chosen: PublicationReviewContext | undefined,
  workOnScreen: boolean,
): readonly PublicationReviewContext[] | null {
  if (!workOnScreen || !catalogue || chosen || catalogue.contexts.length === 0) return null;
  return catalogue.contexts;
}

/** One fixed shape keeps the work mounted in place when continue actions appear beside it. */
function WorkInPlace({
  contexts,
  onChoose,
  children,
}: {
  contexts: readonly PublicationReviewContext[] | null;
  onChoose: (reviewId: string) => void;
  children: ReactNode;
}) {
  return (
    <>
      {contexts ? (
        <section aria-label="关联的任务审阅" className="mx-3 mt-2 rounded-lg border border-cafe-subtle p-2 text-xs">
          <p className="text-cafe-muted">这件作品现在关联了猫的任务审阅：</p>
          {contexts.map((context) => (
            <button
              key={context.reviewId}
              type="button"
              className="mt-1 block text-left font-medium text-cafe-accent"
              onClick={() => onChoose(context.reviewId)}
            >
              {continueReviewLabel(context)}
            </button>
          ))}
        </section>
      ) : null}
      {children}
    </>
  );
}

/** One review is continued by its name; several ask for an explicit choice between them. */
function ContextChoice({
  contexts,
  selection,
  onChoose,
}: {
  contexts: readonly PublicationReviewContext[];
  selection: string | null;
  onChoose: (reviewId: string) => void;
}) {
  const only = contexts.length === 1 ? contexts[0] : undefined;
  if (only)
    return (
      <div className="mt-3 text-sm">
        <p>这件作品关联了猫的任务审阅。</p>
        <button
          type="button"
          className="mt-2 w-full rounded-lg border border-cafe-subtle p-3 text-left"
          onClick={() => onChoose(only.reviewId)}
        >
          <span className="block font-medium">{continueReviewLabel(only)}</span>
          <span className="text-xs text-cafe-muted">{publicationContextLabel(only)}</span>
        </button>
      </div>
    );
  return (
    <label className="mt-3 block text-sm">
      选择这次要继续的讨论
      <select
        aria-label="作品讨论上下文"
        value={selection ?? ''}
        onChange={(event) => onChoose(event.target.value)}
        className="mt-2 w-full rounded border border-cafe-subtle bg-cafe-surface p-2"
      >
        <option value="" disabled>
          请选择原委托
        </option>
        {contexts.map((item) => (
          <option key={item.reviewId} value={item.reviewId}>
            {publicationContextLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}
