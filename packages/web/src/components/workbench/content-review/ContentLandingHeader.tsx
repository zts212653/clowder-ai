import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useArtworkChrome } from '@/components/content-review/ArtworkChrome';
import { useFloatingArtworkPresentation } from '@/components/content-review/ArtworkLightboxScope';
import { ArtworkWorkHeader } from '@/components/content-review/ArtworkWorkHeader';
import { useArtworkWorkMode } from '@/components/content-review/ArtworkWorkModeScope';
import { artworkActionsCopy } from '@/components/content-review/artwork-actions.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { fileReturnLabel } from '@/components/workspace/V2WorkspaceFileChrome';
import { voiceMeetingCopy } from '@/components/workspace/voice-meeting.shell-copy';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';

export function ContentLandingHeader({
  title,
  navigationOrigin,
  onBack,
  onOpenFileTools,
  versionControl,
  leadingAction,
  fullWindowAction,
}: {
  readonly title?: string;
  readonly navigationOrigin?: WorkspaceFileNavigationOrigin;
  readonly onBack?: () => void;
  readonly onOpenFileTools?: () => void;
  readonly versionControl?: ReactNode;
  readonly leadingAction?: ReactNode;
  readonly fullWindowAction?: { active: boolean; onToggle: () => void };
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const copy = useShellCopy(artworkActionsCopy);
  const floating = useFloatingArtworkPresentation();
  const chrome = useArtworkChrome();
  const workMode = useArtworkWorkMode();
  if (floating)
    return chrome?.version
      ? createPortal(
          versionControl ?? (
            <select aria-label={copy.versionLabel} disabled value="1" className="bg-transparent text-inherit">
              <option value="1">{copy.version}</option>
            </select>
          ),
          chrome.version,
        )
      : null;

  if (workMode)
    return (
      <ArtworkWorkHeader
        title={title}
        versionControl={versionControl}
        onReturn={workMode.onReturn}
        fullWindowAction={workMode.fullWindowAction ?? fullWindowAction}
      />
    );

  return (
    // In a narrow column (side-by-side panes, 390px) the controls wrap onto a second line so the
    // title keeps at least ~8rem instead of shrinking to a single character.
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-cafe-subtle px-3 py-2">
      {title ? (
        <h2 className="min-w-[8rem] flex-1 truncate text-sm font-semibold" title={title}>
          {title}
        </h2>
      ) : null}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
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
        <div ref={chrome?.setActions} className="flex shrink-0 items-center gap-2" />
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
      </div>
    </div>
  );
}
