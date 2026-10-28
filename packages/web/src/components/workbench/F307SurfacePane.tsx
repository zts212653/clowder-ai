import type { ReactNode } from 'react';
import { FileToolbarHostControls } from '@/components/content-review/FileToolbar';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { FocusModeButton } from '@/components/workspace/FocusModeButton';
import { WorkspaceFocusExitButton } from '@/components/workspace/WorkspaceFocusShell';
import { resolveArtifactReviewTarget } from './artifact-review-surface';
import { resolvePublicationTarget } from './publication-surface';
import {
  isVoiceDestinationSurface,
  parseArtifactObjectId,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import { WorkspaceChatWorkSurface } from './WorkspaceChatWorkScope';
import { promoteWorkspacePreview } from './WorkspacePreviewIntent';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';

function SurfaceGlyph({ type }: { type: WorkspaceSurfaceDescriptor['type'] }) {
  if (type === 'browser') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M2 5.5h12M4 4h.01M6 4h.01" />
      </svg>
    );
  }
  if (type === 'review' || type === 'artifact') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M3 2.5h7l3 3V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
        <path d="M10 2.5V6h3M4.5 9l1.5 1.5L9.5 7" />
      </svg>
    );
  }
  if (type === 'agent-run') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="4" cy="4" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M3 1.5h6l4 4V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5Z" />
      <path d="M9 1.5v4h4M5 8h6M5 10.5h6" />
    </svg>
  );
}

interface F307SurfacePaneProps {
  surface: WorkspaceSurfaceDescriptor;
  visible?: boolean;
  focusMode?: boolean;
  artifactWorkFullWindow?: boolean;
  onEnterFocusMode?: () => void;
  onExitFocusMode?: () => void;
  onToggleArtifactWorkFullWindow?: () => void;
  children: ReactNode;
}

export function F307SurfacePane(props: F307SurfacePaneProps) {
  // Canonical host names are display projections, including restored descriptors.
  // Classic and other owners keep their stored title; no owner/key changes on locale switches.
  const localizedHost =
    isVoiceDestinationSurface(props.surface) ||
    resolveWorkspaceDestinationTarget(props.surface)?.destinationRef === 'host:status';
  if (useShellPresentation() === 'v2' && localizedHost) {
    return <V2LocalizedHostPane {...props} />;
  }
  return <SurfacePaneBody {...props} />;
}

function V2LocalizedHostPane(props: F307SurfacePaneProps) {
  const t = useShellCopy(workspaceChromeCopy);
  return (
    <SurfacePaneBody
      {...props}
      accessibleName={isVoiceDestinationSurface(props.surface) ? t.voiceSurface.label : t.statusSurface.label}
    />
  );
}

function SurfacePaneBody({
  surface,
  visible = true,
  focusMode = false,
  artifactWorkFullWindow = false,
  onEnterFocusMode,
  onExitFocusMode,
  onToggleArtifactWorkFullWindow,
  children,
  accessibleName,
}: F307SurfacePaneProps & { accessibleName?: string }) {
  const isV2 = useShellPresentation() === 'v2';
  const artifactKind = surface.type === 'artifact' ? parseArtifactObjectId(surface.objectRef.id)?.type : undefined;
  // File-backed catalogue entries render the same reader as Workspace files.
  // Widgets and PRs retain their separate tool chrome and owners.
  const artifactFileChrome = isV2 && !!artifactKind && artifactKind !== 'widget' && artifactKind !== 'pr';
  const chromeOwnedByTool =
    isV2 &&
    (['file', 'code', 'browser', 'terminal', 'workspace'].includes(surface.type) ||
      artifactFileChrome ||
      Boolean(resolveArtifactReviewTarget(surface) || resolvePublicationTarget(surface)));
  return (
    <article
      className={`${visible ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-[var(--console-panel-bg)]`}
      data-surface-id={surface.id}
      data-surface-mounted="true"
      aria-label={accessibleName ?? surface.title}
      aria-hidden={!visible}
      // Promote in the owner's input batch. Updating the external store during capture
      // can restore a controlled field's old value before its change handler receives it.
      onInput={(event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.matches('textarea, [contenteditable="true"]'))
          return;
        promoteWorkspacePreview(surface.id);
      }}
    >
      {!focusMode && !chromeOwnedByTool && (
        <header
          className="flex h-10 shrink-0 items-center gap-2 border-b border-cafe-subtle bg-cafe-surface/70 px-3"
          data-testid="f307-surface-chrome"
        >
          <span className="h-4 w-4 shrink-0 text-cafe-muted">
            <SurfaceGlyph type={surface.type} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cafe">
            {accessibleName ?? surface.title}
          </span>
          <span className="truncate text-micro text-cafe-muted">{surface.context}</span>
          {onToggleArtifactWorkFullWindow ? (
            <button
              type="button"
              className="shrink-0 whitespace-nowrap rounded-lg border border-cafe-subtle bg-cafe-surface-sunken px-2.5 py-1 text-micro font-semibold text-cafe-secondary transition-colors hover:text-cafe"
              onClick={onToggleArtifactWorkFullWindow}
              aria-label={artifactWorkFullWindow ? '展开聊天' : '整窗查看作品'}
              data-testid={
                artifactWorkFullWindow ? 'f307-artifact-exit-full-window' : 'f307-artifact-enter-full-window'
              }
            >
              {artifactWorkFullWindow ? '展开聊天' : '整窗'}
            </button>
          ) : (
            onEnterFocusMode && <FocusModeButton onClick={onEnterFocusMode} />
          )}
        </header>
      )}
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto [&>*]:min-h-0 [&>*]:w-full [&>*]:flex-1"
        data-testid="f307-owner-surface-host"
      >
        <FileToolbarHostControls
          value={
            artifactFileChrome && onToggleArtifactWorkFullWindow ? (
              <button
                type="button"
                className="shrink-0 rounded-md border border-cafe-subtle px-2 py-1 text-xs"
                onClick={onToggleArtifactWorkFullWindow}
                aria-label={artifactWorkFullWindow ? '展开聊天' : '整窗查看作品'}
                data-testid={
                  artifactWorkFullWindow ? 'f307-artifact-exit-full-window' : 'f307-artifact-enter-full-window'
                }
              >
                {artifactWorkFullWindow ? '展开聊天' : '整窗'}
              </button>
            ) : null
          }
        >
          <WorkspaceChatWorkSurface surfaceId={surface.id}>{children}</WorkspaceChatWorkSurface>
        </FileToolbarHostControls>
        {focusMode && onExitFocusMode && (
          <WorkspaceFocusExitButton
            onExit={onExitFocusMode}
            onFullWindow={onToggleArtifactWorkFullWindow}
            fullWindow={artifactWorkFullWindow}
          />
        )}
      </div>
    </article>
  );
}
