'use client';
import type { WorkReference } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { HtmlWidgetBlock } from '@/components/rich/HtmlWidgetBlock';
import { useChatStore } from '@/stores/chatStore';
import { useWorkContent } from './useWorkContent';

/** The original publication surface keeps its identity/return path; only the authorized format chooses its body. */
export function WorkContentBoundary({
  reference,
  threadId: hostThreadId,
  onBack,
  onVersionChange,
  children,
}: {
  reference: WorkReference & { reviewId?: string };
  threadId?: string | null;
  onBack: () => void;
  onVersionChange: (revision: number) => void;
  children: ReactNode;
}) {
  const currentThreadId = useChatStore((state) => state.currentThreadId);
  const isWork = reference.contentRef.startsWith('work:') && !reference.reviewId;
  const { state, reload, refreshVersions } = useWorkContent(isWork ? reference : null, hostThreadId ?? currentThreadId);
  if (!isWork || (state.status === 'ready' && state.content.kind === 'media')) return children;
  const content = state.status === 'ready' && state.content.kind === 'html' ? state.content : null;
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label="HTML 作品预览">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cafe px-3 py-2.5">
        <button type="button" onClick={onBack} className="rounded px-2 py-1 text-xs text-cafe-crosspost">
          返回
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cafe-secondary">
          {content?.title ?? `第 ${reference.ownerRevision} 版`}
        </span>
        {content && (
          <>
            <select
              aria-label="作品版本"
              value={reference.ownerRevision}
              onChange={(event) => onVersionChange(Number(event.target.value))}
              className="max-w-44 rounded-md bg-transparent p-1 text-xs"
            >
              {Array.from({ length: content.latest }, (_, i) => i + 1).map((revision) => (
                <option key={revision} value={revision}>
                  第 {revision} 版 · {revision === content.latest ? '当前' : '历史'}
                </option>
              ))}
            </select>
            <button type="button" onClick={refreshVersions} className="rounded px-2 py-1 text-xs text-cafe-secondary">
              刷新版本
            </button>
          </>
        )}
      </header>
      {state.status === 'loading' && (
        <output className="p-5 text-xs text-cafe-muted">正在读取第 {reference.ownerRevision} 版…</output>
      )}
      {state.status === 'error' && (
        <div role="alert" className="space-y-3 p-5 text-xs text-cafe-error">
          <p>
            {state.unavailable
              ? `找不到第 ${reference.ownerRevision} 版，或你没有查看权限。`
              : `读取第 ${reference.ownerRevision} 版失败，内容未能验证。`}
          </p>
          <button type="button" onClick={reload} className="rounded border border-cafe px-3 py-1.5 text-cafe-secondary">
            重试
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
