'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import type { Ref } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { WorkspaceDevSurface, WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { useChatStore } from '@/stores/chatStore';
import type { WorkspaceSurfaceDescriptor } from '../workbench/workbench-contract';
import { HomeLiveCard } from './HomeLiveCard';
import { HomeStatusSummary } from './HomeStatusSummary';
import { HomeWaitCard } from './HomeWaitCard';
import { HomeWorksSummary, type OpenHomeArtifact } from './HomeWorksSummary';
import { useHomeDestinationSelect } from './use-home-destination';
import { workspaceV3Copy } from './workspace-v3.shell-copy';
import './workspace-home-cards.css';
import './workspace-home-tools.css';
import './workspace-v3.css';
import './home-rows.css';
import './home-unified.css';

/**
 * Workspace v3 Home: all running objects, the current conversation's status/session summary, and latest works.
 * Each "All" opens its original owner. Tools live in the shared + catalogue. It is rendered only while presentation is `v2`
 * (`F307WorkspaceHomePage` decides); the classic home is the other branch there and is not touched by anything here.
 *
 * Wide or narrow is the column's own width (container query in `workspace-home-*.css`), because the Workspace is a draggable
 * 20%–80% panel, not a viewport.
 */
export function WorkspaceHomeV2({
  threadId,
  worktreeId,
  destinationMessage,
  onSelectDevSurface,
  onSelectDestination,
  onSelectExecution,
  scrollRef,
  onOpenArtifact,
  returnArtifactId,
}: {
  threadId?: string;
  defaultCatId: string;
  worktreeId: string | null;
  repository?: { name: string; branch: string };
  workspaceSearch?: LauncherWorkspaceSearch;
  workspaceSearchQuery?: string;
  /** The host's "opening… / no workspace" admission status for the destination just chosen. */
  destinationMessage: string | null;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
  onSelectExecution: (execution: ActiveExecutionProjection) => void;
  scrollRef?: Ref<HTMLDivElement>;
  onOpenVideoProject?: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifact?: OpenHomeArtifact;
  returnArtifactId?: string;
}) {
  const words = useShellCopy(workspaceV3Copy);
  const conversationTitle =
    useChatStore((state) => state.threads?.find((thread) => thread.id === threadId)?.title) || threadId || '';
  const selectDestination = useHomeDestinationSelect({ onSelectDevSurface, onSelectDestination });

  return (
    <div
      ref={scrollRef}
      className="home-v2 min-h-0 flex-1 overflow-y-auto"
      data-testid="f307-workspace-home-page"
      data-home-presentation="v2"
    >
      {/* A Host reservation for the floating Cat Ball (F229): it steps out of this column instead of sitting on the rows it
          would hide and catch clicks for. Only this column is reserved, so a wide panel still leaves its margins to the ball. */}
      <div className="home-column" data-workspace-home-content="">
        <HomeLiveCard threadId={threadId} onSelectExecution={onSelectExecution} />
        <HomeWaitCard hideWhenEmpty />
        <div className="home-conversation-scope text-xs" data-testid="home-conversation-scope">
          <b>{words.thisConversation}</b>
          <span title={conversationTitle}>{conversationTitle}</span>
        </div>
        <HomeStatusSummary threadId={threadId} onSelectDestination={selectDestination} />
        <HomeWorksSummary
          threadId={threadId}
          worktreeId={worktreeId}
          onSelectDestination={selectDestination}
          onOpenArtifact={onOpenArtifact}
          returnArtifactId={returnArtifactId}
        />
        {destinationMessage && (
          <output
            className="home-card home-note text-xs"
            aria-live="polite"
            data-testid="f307-destination-admission-status"
          >
            {destinationMessage}
          </output>
        )}
      </div>
    </div>
  );
}
