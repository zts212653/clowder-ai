'use client';

import type { ContextAttachment, MediaContextAttachment, WorkspaceFileQuoteSource } from '@cat-cafe/shared';
import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ComposerFileQuoteTags } from './ComposerFileQuoteTags';
import { ContextMediaSelections } from './ContextMediaSelections';
import { GalleryAttachmentGroup } from './content-review/GalleryAttachmentGroup';
import { sameGalleryGroup } from './content-review/media-chat-selection';
import { useContextAttachmentPresentation } from './context-attachment-presentation';
import { replyBodyCopy } from './reply-body.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellPresentation } from './shell/shell-presentation';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { ProjectScreeningAttachmentView } from './workbench/video-project/ProjectScreeningAttachmentView';

interface ContextAttachmentViewProps {
  attachment: ContextAttachment;
  compact?: boolean;
  onRemove?: () => void;
  quoteNumber?: number;
}

/**
 * A quote of a place in a file that names no version of it, an old one: the text is kept as it was said, but where
 * that place is in the file now cannot be confirmed. Only a file quote has a version to lack.
 */
function isUnversionedFileQuote(attachment: ContextAttachment): boolean {
  return attachment.kind === 'quote' && attachment.source.kind === 'workspace_file' && !attachment.source.revision;
}

/** The file a chip leads back to: a file attachment itself, or the file a quote was taken from. */
function attachmentFileTarget(
  attachment: ContextAttachment,
): { path: string; lineStart?: number; worktreeId?: string } | null {
  if (attachment.kind === 'workspace_file') return attachment;
  if (attachment.kind === 'quote' && attachment.source.kind === 'workspace_file') return attachment.source;
  return null;
}

/** A historical line is useful only after the owner confirms that the same bytes are still in that file. */
async function confirmQuotedLine(
  source: WorkspaceFileQuoteSource,
): Promise<{ state: 'current' | 'changed' | 'unlocated'; line: number | null }> {
  if (!source.revision || !source.worktreeId) return { state: 'unlocated', line: null };
  try {
    const query = new URLSearchParams({ worktreeId: source.worktreeId, path: source.path });
    const response = await apiFetch(`/api/workspace/file?${query}`);
    if (!response.ok) throw new Error('File location unavailable');
    const file = await response.json();
    if (file.path !== source.path || typeof file.sha256 !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('File version unavailable');
    return `sha256:${file.sha256.replace(/^sha256:/, '')}` === source.revision
      ? { state: 'current', line: source.lineStart ?? null }
      : { state: 'changed', line: null };
  } catch {
    return { state: 'unlocated', line: null };
  }
}

export function ContextAttachmentView(props: ContextAttachmentViewProps) {
  return props.attachment.kind === 'project-screening' ? (
    <ProjectScreeningAttachmentView {...props} attachment={props.attachment} />
  ) : (
    <OrdinaryContextAttachmentView {...props} />
  );
}

function OrdinaryContextAttachmentView({
  attachment,
  compact = false,
  onRemove,
  quoteNumber,
}: ContextAttachmentViewProps) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useShellCopy(replyBodyCopy);
  const presentation = useContextAttachmentPresentation(attachment, isV2);
  const fileTarget = attachmentFileTarget(attachment);
  const actionable = attachment.kind === 'thread' || fileTarget !== null;
  const [location, setLocation] = useState<'changed' | 'unlocated' | null>(null);
  const [opening, setOpening] = useState(false);
  const openAttachment = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (attachment.kind === 'thread') {
      pushThreadRouteWithHistory(attachment.threadId, typeof window === 'undefined' ? undefined : window);
      return;
    }
    if (fileTarget) {
      const state = useChatStore.getState();
      const messageId = event.currentTarget.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
      let line = fileTarget.lineStart ?? null;
      if (attachment.kind === 'quote' && attachment.source.kind === 'workspace_file') {
        // Historical lines refer to historical bytes. Confirm the owner version before using one now.
        setOpening(true);
        const result = await confirmQuotedLine(attachment.source);
        setOpening(false);
        setLocation(result.state === 'current' ? null : result.state);
        const current = useChatStore.getState();
        if (
          current.currentThreadId !== state.currentThreadId ||
          current.workspaceOpenRevision !== state.workspaceOpenRevision
        )
          return;
        line = result.line;
      }

      state.setWorkspaceMode('dev');
      state.setWorkspaceOpenFile(
        fileTarget.path,
        line,
        fileTarget.worktreeId ?? null,
        state.currentThreadId,
        state.currentThreadId && messageId
          ? { kind: 'chat-file-link', threadId: state.currentThreadId, messageId }
          : undefined,
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
            {presentation.kindLabel}
          </span>
          <span className="block min-w-0 truncate text-xs font-medium text-cafe-secondary">{presentation.title}</span>
          {quoteNumber ? <span className="shrink-0 text-xs text-cafe-secondary">{t.place(quoteNumber)}</span> : null}
        </span>
        <span
          className={`block text-micro text-cafe-muted ${attachment.kind === 'quote' ? 'line-clamp-3 whitespace-pre-wrap' : 'truncate font-mono'}`}
        >
          {presentation.detail}
        </span>
        {(isUnversionedFileQuote(attachment) || location) && (
          <span className="mt-0.5 block text-micro text-cafe-secondary">
            {location === 'changed' ? t.changedFileQuote : t.unversionedFileQuote}
          </span>
        )}
        {attachment.kind === 'media' && (
          <ContextMediaSelections attachment={attachment} compact={compact} removable={Boolean(onRemove)} />
        )}
        {attachment.kind === 'quote' && attachment.comment && (
          <span className="mt-1.5 block border-l-2 border-cafe-accent/50 pl-2 text-xs leading-relaxed text-cafe-primary">
            <span className={`mr-1 text-micro font-semibold ${isV2 ? '' : 'uppercase '}tracking-wide text-cafe-muted`}>
              {presentation.commentLabel}
            </span>
            {attachment.comment}
          </span>
        )}
      </span>
    </>
  );

  if (isV2 && compact && onRemove && attachment.kind === 'media' && attachment.selections.length)
    return (
      <div
        data-testid={`context-attachment-${attachment.id}`}
        data-context-kind="media"
        className="flex min-w-0 items-center gap-2 px-2 py-1 text-xs"
      >
        <span className="max-w-32 truncate" title={attachment.title}>
          {attachment.title}
        </span>
        <ContextMediaSelections attachment={attachment} compact removable />
        <button
          type="button"
          aria-label={presentation.removeLabel}
          onClick={onRemove}
          className="shrink-0 rounded px-1 text-cafe-muted hover:bg-cafe-surface-sunken"
        >
          ×
        </button>
      </div>
    );

  return (
    <div
      data-testid={`context-attachment-${attachment.id}`}
      data-context-kind={attachment.kind}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-cafe-subtle bg-cafe-surface-elevated ${compact ? 'px-2 py-1.5' : 'my-2 px-3 py-2'}`}
    >
      {actionable ? (
        <button
          type="button"
          disabled={opening}
          onClick={(event) => void openAttachment(event)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={presentation.removeLabel}
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
  const v2FileTags = useShellPresentation() === 'v2' && compact && Boolean(onRemove);
  if (attachments.length === 0) return null;
  const fileQuotes = v2FileTags
    ? attachments.filter(
        (attachment): attachment is Extract<ContextAttachment, { kind: 'quote' }> =>
          attachment.kind === 'quote' && attachment.source.kind === 'workspace_file',
      )
    : [];
  const fileQuoteIds = new Set(fileQuotes.map((quote) => quote.id));
  const annotations = attachments.filter(
    (attachment): attachment is Extract<ContextAttachment, { kind: 'quote' }> =>
      attachment.kind === 'quote' && Boolean(attachment.comment) && !fileQuoteIds.has(attachment.id),
  );
  const annotationIds = new Set(annotations.map((attachment) => attachment.id));
  const quoteNumbers = new Map(
    attachments
      .filter((attachment) => attachment.kind === 'quote' && attachment.source.kind === 'workspace_file')
      .map((attachment, index) => [attachment.id, index + 1]),
  );
  let annotationSummaryRendered = false;
  let fileTagsRendered = false;
  const renderedGalleries = new Set<string>();
  return (
    <div
      data-testid="context-attachment-list"
      className={compact ? 'relative flex flex-wrap gap-2 px-4 pt-2' : undefined}
    >
      {attachments.map((attachment) => {
        if (attachment.kind === 'media' && attachment.gallery) {
          if (renderedGalleries.has(attachment.id)) return null;
          const group = attachments.filter(
            (item): item is MediaContextAttachment =>
              item.kind === 'media' && !!item.gallery && sameGalleryGroup(attachment.gallery!, item.gallery),
          );
          for (const member of group) renderedGalleries.add(member.id);
          return (
            <GalleryAttachmentGroup key={attachment.id} attachments={group} compact={compact} onRemove={onRemove} />
          );
        }
        if (fileQuoteIds.has(attachment.id) && onRemove) {
          if (fileTagsRendered) return null;
          fileTagsRendered = true;
          return (
            <ComposerFileQuoteTags
              key="file-quote-tags"
              quotes={fileQuotes}
              numbers={quoteNumbers}
              onRemove={onRemove}
            />
          );
        }
        if (annotationIds.has(attachment.id)) {
          if (annotationSummaryRendered) return null;
          annotationSummaryRendered = true;
          return (
            <ContextAnnotationSummary
              key="context-annotations-summary"
              annotations={annotations}
              compact={compact}
              onRemove={onRemove}
              quoteNumbers={quoteNumbers}
            />
          );
        }
        return (
          <ContextAttachmentView
            key={attachment.id}
            attachment={attachment}
            compact={compact}
            quoteNumber={quoteNumbers.get(attachment.id)}
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
  quoteNumbers,
}: {
  annotations: readonly Extract<ContextAttachment, { kind: 'quote' }>[];
  compact: boolean;
  onRemove?: (id: string) => void;
  quoteNumbers: ReadonlyMap<string, number>;
}) {
  const t = useShellCopy(replyBodyCopy);
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
                {quoteNumbers.has(annotation.id)
                  ? t.place(quoteNumbers.get(annotation.id) ?? index + 1)
                  : `${index + 1}. Selected text`}
              </div>
              <blockquote className="line-clamp-5 whitespace-pre-wrap text-sm leading-relaxed text-cafe-secondary">
                {annotation.text}
              </blockquote>
              {isUnversionedFileQuote(annotation) && (
                <p className="mt-1 text-micro text-cafe-secondary">{t.unversionedFileQuote}</p>
              )}
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
