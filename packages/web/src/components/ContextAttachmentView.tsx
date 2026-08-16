'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

interface ContextAttachmentViewProps {
  attachment: ContextAttachment;
  compact?: boolean;
  onRemove?: () => void;
}

function attachmentPresentation(attachment: ContextAttachment): { title: string; detail: string } {
  switch (attachment.kind) {
    case 'thread':
      return { title: attachment.title, detail: attachment.threadId };
    case 'workspace_file':
      return {
        title: attachment.path.split('/').pop() || attachment.path,
        detail: [attachment.path, attachment.branch ?? attachment.worktreeId].filter(Boolean).join(' · '),
      };
    case 'quote': {
      const source =
        attachment.source.kind === 'workspace_file'
          ? attachment.source.path
          : attachment.source.kind === 'cli_output'
            ? 'CLI Output'
            : 'Message quote';
      return { title: source, detail: attachment.text };
    }
  }
}

const ATTACHMENT_KIND_LABELS: Record<ContextAttachment['kind'], string> = {
  thread: 'THREAD',
  workspace_file: 'FILE',
  quote: 'QUOTE',
};

export function ContextAttachmentView({ attachment, compact = false, onRemove }: ContextAttachmentViewProps) {
  const presentation = attachmentPresentation(attachment);
  const actionable = attachment.kind === 'thread' || attachment.kind === 'workspace_file';
  const openAttachment = () => {
    if (attachment.kind === 'thread') {
      pushThreadRouteWithHistory(attachment.threadId, typeof window === 'undefined' ? undefined : window);
      return;
    }
    if (attachment.kind === 'workspace_file') {
      const state = useChatStore.getState();
      state.setWorkspaceMode('dev');
      state.setWorkspaceOpenFile(
        attachment.path,
        attachment.lineStart ?? null,
        attachment.worktreeId ?? null,
        state.currentThreadId,
      );
    }
  };

  const body = (
    <>
      <svg className="h-4 w-4 shrink-0 text-cafe-accent" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M4 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2v3l4-3h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z" />
      </svg>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded bg-cafe-surface-sunken px-1 py-0.5 text-micro font-semibold tracking-wide text-cafe-muted">
            {ATTACHMENT_KIND_LABELS[attachment.kind]}
          </span>
          <span className="block min-w-0 truncate text-xs font-medium text-cafe-secondary">{presentation.title}</span>
        </span>
        <span
          className={`block text-micro text-cafe-muted ${attachment.kind === 'quote' ? 'line-clamp-3 whitespace-pre-wrap' : 'truncate font-mono'}`}
        >
          {presentation.detail}
        </span>
        {attachment.kind === 'quote' && attachment.comment && (
          <span className="mt-1.5 block border-l-2 border-cafe-accent/50 pl-2 text-xs leading-relaxed text-cafe-primary">
            <span className="mr-1 text-micro font-semibold uppercase tracking-wide text-cafe-muted">Comment</span>
            {attachment.comment}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div
      data-testid={`context-attachment-${attachment.id}`}
      data-context-kind={attachment.kind}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-cafe-subtle bg-cafe-surface-elevated ${compact ? 'px-2 py-1.5' : 'my-2 px-3 py-2'}`}
    >
      {actionable ? (
        <button type="button" onClick={openAttachment} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`移除上下文 ${presentation.title}`}
          onClick={onRemove}
          className="rounded p-1 text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe-secondary"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="m5.7 4.3 4.3 4.3 4.3-4.3 1.4 1.4-4.3 4.3 4.3 4.3-1.4 1.4-4.3-4.3-4.3 4.3-1.4-1.4L8.6 10 4.3 5.7l1.4-1.4Z" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function ContextAttachmentList({
  attachments,
  compact = false,
  onRemove,
}: {
  attachments: readonly ContextAttachment[];
  compact?: boolean;
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  const annotations = attachments.filter(
    (attachment): attachment is Extract<ContextAttachment, { kind: 'quote' }> =>
      attachment.kind === 'quote' && Boolean(attachment.comment),
  );
  const annotationIds = new Set(annotations.map((attachment) => attachment.id));
  let annotationSummaryRendered = false;
  return (
    <div
      data-testid="context-attachment-list"
      className={compact ? 'relative flex flex-wrap gap-2 px-4 pt-2' : undefined}
    >
      {attachments.map((attachment) => {
        if (annotationIds.has(attachment.id)) {
          if (annotationSummaryRendered) return null;
          annotationSummaryRendered = true;
          return (
            <ContextAnnotationSummary
              key="context-annotations-summary"
              annotations={annotations}
              compact={compact}
              onRemove={onRemove}
            />
          );
        }
        return (
          <ContextAttachmentView
            key={attachment.id}
            attachment={attachment}
            compact={compact}
            onRemove={onRemove ? () => onRemove(attachment.id) : undefined}
          />
        );
      })}
    </div>
  );
}

function ContextAnnotationSummary({
  annotations,
  compact,
  onRemove,
}: {
  annotations: readonly Extract<ContextAttachment, { kind: 'quote' }>[];
  compact: boolean;
  onRemove?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        data-testid="context-annotations-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={`flex items-center gap-2 rounded-full border border-cafe-subtle bg-cafe-surface-elevated text-cafe-secondary shadow-sm hover:bg-cafe-surface-sunken ${compact ? 'px-3 py-1.5 text-xs' : 'my-2 px-3 py-2 text-sm'}`}
      >
        <svg className="h-4 w-4 text-cafe-accent" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M4 3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2v3l4-3h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z" />
        </svg>
        <span>
          {annotations.length} {annotations.length === 1 ? 'annotation' : 'annotations'}
        </span>
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path d="m2.5 4.5 3.5 3 3.5-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {expanded && (
        <div
          className={`${compact ? 'absolute bottom-full left-0 z-[75] mb-2 w-[min(30rem,calc(100vw-2rem))]' : 'mb-2'} overflow-hidden rounded-2xl border border-cafe bg-cafe-surface-elevated shadow-xl`}
        >
          {annotations.map((annotation, index) => (
            <article
              key={annotation.id}
              data-testid={`context-annotation-item-${annotation.id}`}
              className="border-b border-cafe-subtle px-4 py-3 last:border-b-0"
            >
              <div className="mb-1 text-micro font-semibold uppercase tracking-[0.14em] text-cafe-muted">
                {index + 1}. Selected text
              </div>
              <blockquote className="line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-cafe-secondary">
                {annotation.text}
              </blockquote>
              <div className="mb-1 mt-3 text-micro font-semibold uppercase tracking-[0.14em] text-cafe-muted">
                User comment
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-cafe-primary">{annotation.comment}</p>
              {onRemove && (
                <button
                  type="button"
                  aria-label={`移除批注 ${index + 1}`}
                  onClick={() => onRemove(annotation.id)}
                  className="mt-2 text-micro text-cafe-muted hover:text-conn-red-text"
                >
                  移除
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
