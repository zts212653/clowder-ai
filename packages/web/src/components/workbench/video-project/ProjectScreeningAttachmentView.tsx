'use client';
import type { ProjectScreeningContextAttachment, VideoProjectScreeningSelection } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createVideoProjectSurface } from '../video-project-surface';

function selectionLabel(selection: VideoProjectScreeningSelection) {
  const target = selection.target;
  if (target.kind === 'segment') return `镜头 ${target.segmentId}`;
  if (target.kind === 'artwork') return '画稿位置';
  if (target.kind === 'project') return '全片位置';
  return selection.displayRegion ? '画面选区' : '时间片段';
}

/** Pending and sent chips open the same frozen film; opening a place never sends another message. */
export function ProjectScreeningAttachmentView({
  attachment,
  compact = false,
  onRemove,
}: {
  attachment: ProjectScreeningContextAttachment;
  compact?: boolean;
  onRemove?: () => void;
}) {
  const open = (selection: VideoProjectScreeningSelection) => {
    const surface = createVideoProjectSurface({
      contentRef: attachment.contentRef,
      screeningId: attachment.screeningId,
      title: attachment.title,
      position: { pts: selection.mediaRange.startPts, requestId: Date.now() },
    });
    useChatStore.getState().setWorkspaceMode('dev');
    useF307ExperienceWorkbenchStore
      .getState()
      .dispatch({ type: 'open-surface', surface, entitlement: { kind: 'user', reason: 'return-origin' } });
  };
  return (
    <div
      data-testid={`context-attachment-${attachment.id}`}
      data-context-kind={attachment.kind}
      className={`min-w-0 rounded-lg border border-cafe-subtle bg-cafe-surface-elevated ${compact ? 'px-3 py-2' : 'my-2 px-3 py-2'}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded bg-cafe-surface-sunken px-1.5 py-0.5 font-semibold text-cafe-muted">审片</span>
        <span className="min-w-0 flex-1 truncate text-cafe-secondary">
          {attachment.title} · 输入 v{attachment.input.ownerRevision}
        </span>
        {onRemove && (
          <button
            type="button"
            aria-label={`移除审片位置 ${attachment.title}`}
            onClick={onRemove}
            className="text-cafe-muted"
          >
            移除
          </button>
        )}
      </div>
      <ul className="mt-1.5 space-y-1">
        {attachment.selections.map((selection, index) => (
          <li key={selection.id}>
            <button
              type="button"
              onClick={() => open(selection)}
              aria-label={`回到${attachment.title}的标记 ${index + 1}`}
              className="text-left text-xs text-cafe-secondary underline decoration-cafe-subtle underline-offset-2"
            >
              {selectionLabel(selection)}
              {attachment.selections.length > 1 ? ` ${index + 1}` : ''} · 回到原片
            </button>
            {selection.comment && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-cafe-primary">{selection.comment}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
