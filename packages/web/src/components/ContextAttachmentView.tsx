'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
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
  return (
    <div data-testid="context-attachment-list" className={compact ? 'flex flex-wrap gap-2 px-4 pt-2' : undefined}>
      {attachments.map((attachment) => (
        <ContextAttachmentView
          key={attachment.id}
          attachment={attachment}
          compact={compact}
          onRemove={onRemove ? () => onRemove(attachment.id) : undefined}
        />
      ))}
    </div>
  );
}
