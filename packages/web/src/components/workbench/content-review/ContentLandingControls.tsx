import type { ReactNode } from 'react';
import { useArtworkChrome } from '@/components/content-review/ArtworkChrome';
import { artworkActionsCopy } from '@/components/content-review/artwork-actions.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { fileReturnLabel } from '@/components/workspace/V2WorkspaceFileChrome';
import { voiceMeetingCopy } from '@/components/workspace/voice-meeting.shell-copy';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';

export function ContentLandingControls({
  leadingAction,
  versionControl,
  fullWindowAction,
  onOpenFileTools,
  onBack,
  navigationOrigin,
  includeFileActionsSlot = true,
}: {
  leadingAction?: ReactNode;
  versionControl?: ReactNode;
  fullWindowAction?: { active: boolean; onToggle: () => void };
  onOpenFileTools?: () => void;
  onBack?: () => void;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  includeFileActionsSlot?: boolean;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const copy = useShellCopy(artworkActionsCopy);
  const chrome = useArtworkChrome();
  return (
    <>
      {leadingAction}
      {versionControl}
      {fullWindowAction ? (
        <button
          type="button"
          className="shrink-0 rounded-md border border-cafe-subtle px-2 py-1 text-xs hover:bg-cafe-surface-elevated"
          onClick={fullWindowAction.onToggle}
          aria-label={fullWindowAction.active ? copy.expandChat : copy.fullWindow}
          data-testid={fullWindowAction.active ? 'f307-artifact-exit-full-window' : 'f307-artifact-enter-full-window'}
        >
          {fullWindowAction.active ? copy.expandChat : copy.fullWindow}
        </button>
      ) : null}
      {onOpenFileTools ? (
        <button
          type="button"
          onClick={onOpenFileTools}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
        >
          {copy.fileTools}
        </button>
      ) : null}
      {includeFileActionsSlot && <div ref={chrome?.setActions} className="flex shrink-0 items-center gap-2" />}
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
        >
          {/* C 3480: a meeting-panel origin names its source explicitly (in the current shell language,
                since only the v2 meeting journey produces this origin) instead of the generic 返回来源. */}
          {navigationOrigin?.kind === 'meeting-transcript'
            ? `‹ ${t.meeting.title}`
            : navigationOrigin
              ? fileReturnLabel(navigationOrigin)
              : copy.returnToSource}
        </button>
      ) : null}
    </>
  );
}
