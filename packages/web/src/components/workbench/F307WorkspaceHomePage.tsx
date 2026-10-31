'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import {
  type WorkspaceDevSurface,
  WorkspaceLauncher,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { WorkspaceNowSurface } from '@/components/workspace/WorkspaceNowSurface';
import type { OpenHomeArtifact } from '@/components/workspace-home/HomeWorksSummary';
import { WorkspaceHomeV2 } from '@/components/workspace-home/WorkspaceHomeV2';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { createAgentRunSurface, createFileSurface } from './real-surface-adapters';
import {
  useWorkspaceDestinationAdmission,
  type WorkspaceDestinationAdmission,
} from './use-workspace-destination-admission';
import { useWorkspaceHomeReturn } from './use-workspace-home-return';
import { VideoProjectList } from './video-project/VideoProjectList';

type HomeSearchOrigin = Extract<WorkspaceFileNavigationOrigin, { kind: 'workspace-home-search' }>;
const SEARCH_INPUT = '[data-testid="workspace-launcher-search"]';

export function F307WorkspaceHomePage({
  threadId,
  defaultCatId,
  onSelectDevSurface,
  onSelectSurface,
  worktreeId,
  canonicalWorktreeId,
  worktreeLoading = false,
  worktreeError = null,
  openFilePath,
  preview,
  repository,
  rootSelection,
  workspaceSearch,
  workspaceSearchQuery,
  workspaceSearchReturnOrigin,
  workspaceArtifactReturnOrigin,
  destinationAdmission,
  onOpenArtifact,
}: {
  threadId?: string;
  defaultCatId: string;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  onSelectSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  worktreeId: string | null;
  canonicalWorktreeId?: string | null;
  worktreeLoading?: boolean;
  worktreeError?: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
  repository?: { name: string; branch: string };
  rootSelection?: WorkspaceSurfaceDescriptor['rootSelection'];
  workspaceSearch?: LauncherWorkspaceSearch;
  /** F307 host restores this transient value after an ordinary Home-origin return. */
  workspaceSearchQuery?: string;
  workspaceSearchReturnOrigin?: HomeSearchOrigin;
  destinationAdmission?: WorkspaceDestinationAdmission;
  onOpenArtifact?: OpenHomeArtifact;
  workspaceArtifactReturnOrigin?: Extract<WorkspaceFileNavigationOrigin, { kind: 'workspace-home-artifact' }>;
}) {
  const presentation = useShellPresentation();
  const homeRef = useWorkspaceHomeReturn(
    workspaceArtifactReturnOrigin ?? workspaceSearchReturnOrigin,
    presentation,
    threadId,
  );
  const threadTitle = useChatStore((state) => state.threads.find((thread) => thread.id === threadId)?.title);
  const localAdmission = useWorkspaceDestinationAdmission({
    context: { threadId, threadTitle, worktreeId, canonicalWorktreeId, openFilePath, preview },
    worktreeLoading,
    worktreeError,
    onSelectSurface,
    enabled: !destinationAdmission,
  });
  const admission = destinationAdmission ?? localAdmission;
  const destinationMessage = admission.message;
  const selectDestination = (destination: WorkspaceLauncherDestination) => {
    // The classic Launcher has already opened the original replay overlay.
    if (presentation === 'classic' && destination.kind === 'action') return;
    admission.onSelectDestination(destination);
  };

  const launcherSearch: LauncherWorkspaceSearch | undefined = workspaceSearch
    ? {
        ...workspaceSearch,
        onOpenResult: (path, line) => {
          const input = homeRef.current?.querySelector<HTMLInputElement>(SEARCH_INPUT);
          const original = workspaceSearch.fileNavigationOrigin?.();
          const origin: WorkspaceFileNavigationOrigin | undefined =
            input && homeRef.current && input.value.trim()
              ? {
                  kind: 'workspace-home-search',
                  query: input.value.trim(),
                  viewportOffsetPx: input.getBoundingClientRect().top - homeRef.current.getBoundingClientRect().top,
                }
              : original;
          // Capture before the host changes presentation and unmounts Home. Two-argument callers remain valid.
          if (origin?.kind === 'workspace-home-search' && origin.viewportOffsetPx !== undefined)
            workspaceSearch.onOpenResult(path, line, origin);
          else workspaceSearch.onOpenResult(path, line);
          if (presentation !== 'v2' && worktreeId)
            onSelectSurface(
              createFileSurface({
                worktreeId,
                path,
                scrollToLine: line,
                navigationOrigin: origin,
                ...(rootSelection ? { rootSelection } : {}),
              }),
            );
        },
      }
    : undefined;
  const openRunningObject = (execution: ActiveExecutionProjection) => {
    const surface = createAgentRunSurface({ execution });
    if (surface) onSelectSurface(surface);
  };

  // Both presentations keep their original sources and callbacks inside a stable Home content box.
  if (presentation === 'v2') {
    return (
      <WorkspaceHomeV2
        scrollRef={homeRef}
        onOpenArtifact={onOpenArtifact}
        returnArtifactId={
          workspaceArtifactReturnOrigin && workspaceArtifactReturnOrigin.threadId === threadId
            ? workspaceArtifactReturnOrigin.artifactId
            : undefined
        }
        threadId={threadId}
        defaultCatId={defaultCatId}
        worktreeId={worktreeId}
        repository={repository}
        workspaceSearch={launcherSearch}
        workspaceSearchQuery={workspaceSearchQuery}
        destinationMessage={destinationMessage}
        onSelectDevSurface={onSelectDevSurface}
        onSelectDestination={selectDestination}
        onSelectExecution={openRunningObject}
        onOpenVideoProject={onSelectSurface}
      />
    );
  }

  return (
    <div
      ref={homeRef}
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--console-panel-bg)]"
      data-testid="f307-workspace-home-page"
    >
      <div className="flow-root" data-workspace-home-content="">
        <WorkspaceNowSurface repository={repository} onSelectExecution={openRunningObject} />
        <VideoProjectList onOpen={onSelectSurface} />
        {destinationMessage && (
          <div className="mx-auto w-full max-w-4xl px-5 pt-3">
            <div
              className="rounded-xl border border-cafe-subtle bg-cafe-surface px-4 py-3 text-xs text-cafe-secondary"
              role="status"
              aria-live="polite"
              data-testid="f307-destination-admission-status"
            >
              {destinationMessage}
            </div>
          </div>
        )}
        <WorkspaceLauncher
          threadId={threadId}
          defaultCatId={defaultCatId}
          initialSearchQuery={workspaceSearchQuery}
          onSelectDevSurface={onSelectDevSurface}
          workspaceSearch={launcherSearch}
          onSelectDestination={selectDestination}
        />
      </div>
    </div>
  );
}
