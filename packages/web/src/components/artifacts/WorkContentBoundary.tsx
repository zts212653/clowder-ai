'use client';
import type { WorkReference } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { HtmlWidgetBlock } from '@/components/rich/HtmlWidgetBlock';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useChatStore } from '@/stores/chatStore';
import { useWorkContent } from './useWorkContent';
import { workContentCopy } from './work-content.shell-copy';

/** HTML entry intent supplies its original read context; existing media owners remain untouched. Every HTML read is reauthorized. */
export function WorkContentBoundary({
  reference,
  threadId: hostThreadId,
  sourceThreadId,
  onBack,
  onVersionChange,
  children,
}: {
  reference: WorkReference & { reviewId?: string };
  threadId?: string | null;
  sourceThreadId?: string;
  onBack: () => void;
  onVersionChange: (revision: number) => void;
  children: ReactNode;
}) {
  const t = useShellCopy(workContentCopy);
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const isHtmlWork = reference.contentRef.startsWith('work:') && !reference.reviewId && !!sourceThreadId;
  const { state, reload, refreshVersions } = useWorkContent(
    isHtmlWork ? reference : null,
    hostThreadId ?? currentThreadId,
    sourceThreadId,
  );
  if (!isHtmlWork || (state.status === 'ready' && state.content.kind === 'media')) return children;
  const content = state.status === 'ready' && state.content.kind === 'html' ? state.content : null;
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={t.preview}>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cafe px-3 py-2.5">
        <button type="button" onClick={onBack} className="rounded px-2 py-1 text-xs text-cafe-crosspost">
          {t.back}
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cafe-secondary">
          {content?.title ?? t.version(reference.ownerRevision)}
        </span>
        {content && (
          <>
            <select
              aria-label={t.versions}
              value={reference.ownerRevision}
              onChange={(event) => onVersionChange(Number(event.target.value))}
              className="max-w-44 rounded-md bg-transparent p-1 text-xs"
            >
              {Array.from({ length: content.latest }, (_, i) => i + 1).map((revision) => (
                <option key={revision} value={revision}>
                  {t.versionOption(revision, revision === content.latest)}
                </option>
              ))}
            </select>
            <button type="button" onClick={refreshVersions} className="rounded px-2 py-1 text-xs text-cafe-secondary">
              {t.refresh}
            </button>
          </>
        )}
      </header>
      {state.status === 'loading' && (
        <output className="p-5 text-xs text-cafe-muted">{t.loading(reference.ownerRevision)}</output>
      )}
      {state.status === 'error' && (
        <div role="alert" className="space-y-3 p-5 text-xs text-cafe-error">
          <p>{state.unavailable ? t.unavailable(reference.ownerRevision) : t.failed(reference.ownerRevision)}</p>
          <button type="button" onClick={reload} className="rounded border border-cafe px-3 py-1.5 text-cafe-secondary">
            {t.retry}
          </button>
        </div>
      )}
      {content && (
        <div className="flex min-h-0 flex-1 flex-col p-3" data-html-work-version={reference.ownerRevision}>
          <HtmlWidgetBlock
            key={JSON.stringify([reference.contentRef, reference.ownerRevision])}
            presentation="workspace"
            block={{
              id: JSON.stringify([reference.contentRef, reference.ownerRevision]),
              kind: 'html_widget',
              v: 1,
              title: content.title,
              html: content.html,
            }}
          />
        </div>
      )}
    </section>
  );
}
