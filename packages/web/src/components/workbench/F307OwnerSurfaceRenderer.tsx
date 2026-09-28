'use client';

import { type ReactNode, useCallback } from 'react';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { ArtifactsPanel } from '@/components/ArtifactsPanel';
import { CommunityPanel } from '@/components/CommunityPanel';
import { CapabilityEvolutionWorkspace } from '@/components/capability-evolution/CapabilityEvolutionWorkspace';
import { EvolutionProgramSurface } from '@/components/capability-evolution/EvolutionProgramSurface';
import { ArtifactReviewSurface } from '@/components/content-review/ArtifactReviewSurface';
import { EvalWorkspacePanel } from '@/components/eval-workspace/EvalWorkspacePanel';
import { RecallFeed } from '@/components/memory/RecallFeed';
import { TeamWorkspacePanel } from '@/components/routing-context/TeamWorkspacePanel';
import { TaskBoardPanel } from '@/components/TaskBoardPanel';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { BrowserPanel } from '@/components/workspace/BrowserPanel';
import { ChangesPanel } from '@/components/workspace/ChangesPanel';
import { GitPanel } from '@/components/workspace/GitPanel';
import { SchedulePanel } from '@/components/workspace/SchedulePanel';
import { TerminalTab } from '@/components/workspace/TerminalTab';
import { ThreadChatLink } from '@/components/workspace/ThreadChatLink';
import { TrajectoryPanel } from '@/components/workspace/trajectory/TrajectoryPanel';
import { useChatStore } from '@/stores/chatStore';
import { resolveArtifactReviewTarget } from './artifact-review-surface';
import {
  isCapabilityEvolutionWorkspaceSurface,
  resolveCapabilityEvolutionTargetThreadId,
} from './capability-evolution-workspace-adapter';
import { ContentEditorOwnerSurface } from './content-editor/ContentEditorOwnerSurface';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { F307ArtifactOwnerSurface } from './F307ArtifactOwnerSurface';
import { F307FileOwnerSurface } from './F307FileOwnerSurface';
import { F307FilesOwnerSurface } from './F307FilesOwnerSurface';
import { F307OwnerUnavailable as OwnerUnavailable } from './F307OwnerUnavailable';
import { NeedsMeOwnerSurface, ProductScheduleOwnerSurface } from './GrowingOwnerSurfaces';
import {
  createArtifactSurface,
  createBrowserSurface,
  createEvolutionProgramSurface,
  createTeamWorkspaceSurface,
  resolveAgentRunTarget,
  resolveApprovalActionTarget,
  resolveBrowserTarget,
  resolveChangesTarget,
  resolveContentEditorTarget,
  resolveEvolutionProgramId,
  resolveTeamWorkspaceTarget,
  resolveTerminalWorktreeId,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import { WorkspaceSurfaceVisibilityProvider } from './WorkspaceSurfaceVisibility';

function AgentRunOwnerSurface({ surface }: { surface: WorkspaceSurfaceDescriptor }) {
  const target = resolveAgentRunTarget(surface);
  if (!target?.threadId) return <OwnerUnavailable message="Agent Run descriptor 没有合法的 F299 invocation 引用。" />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 justify-end border-b border-cafe-subtle px-3 py-2">
        <ThreadChatLink threadId={target.threadId} />
      </div>
      <div className="min-h-0 flex-1">
        <TrajectoryPanel threadId={target.threadId} targetOverride={target} />
      </div>
    </div>
  );
}

function TeamWorkspaceOwnerSurface({
  surface,
  onRefreshSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const setTeamWorkspaceSubject = useChatStore((state) => state.setTeamWorkspaceSubject);
  const target = resolveTeamWorkspaceTarget(surface);
  if (!target) return <OwnerUnavailable message="Team descriptor 没有合法的 F293 owner/subject 引用。" />;
  return (
    <TeamWorkspacePanel
      subject={target.subject}
      // Same owner-state key the descriptor uses, so one thread's reading posture
      // never leaks into another's Team surface.
      ownerKey={target.threadId ?? 'global'}
      onSubjectChange={(subject) => {
        setTeamWorkspaceSubject(subject);
        onRefreshSurface(createTeamWorkspaceSurface({ threadId: target.threadId ?? undefined, subject }));
      }}
    />
  );
}

function WorkspaceModeOwnerSurface({
  surface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
  statusSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  statusSurface?: ReactNode;
}) {
  const target = resolveWorkspaceDestinationTarget(surface);
  if (!target) return <OwnerUnavailable message="Workspace destination 没有合法 owner/result target。" />;
  const { destinationRef: destination, threadId } = target;
  if (destination === 'host:status') {
    return statusSurface ?? <OwnerUnavailable message="当前 Thread 的状态 owner 暂时不可用。" />;
  }
  if (destination === 'surface:git') return <GitPanel />;
  if (destination === 'mode:tasks') return <TaskBoardPanel />;
  if (destination === 'mode:needs-me') {
    return (
      <NeedsMeOwnerSurface
        surface={surface}
        onOpenSurface={onOpenSurface}
        onOpenArtifactWithReturn={onOpenArtifactWithReturn}
        onRefreshSurface={onRefreshSurface}
      />
    );
  }
  if (destination === 'mode:product-schedule') {
    return <ProductScheduleOwnerSurface surface={surface} onOpenArtifactWithReturn={onOpenArtifactWithReturn} />;
  }
  if (destination === 'mode:schedule') return <SchedulePanel />;
  if (destination === 'mode:approval') {
    return <ApprovalPanel selectedProposalId={resolveApprovalActionTarget(surface)?.proposalId ?? null} />;
  }
  if (destination === 'mode:recall') return <RecallFeed />;
  if (destination === 'mode:eval') return <EvalWorkspacePanel />;
  if (destination === 'mode:community' && threadId) return <CommunityPanel threadId={threadId} />;
  if (destination === 'mode:trajectory') return <TrajectoryPanel threadId={threadId ?? undefined} />;
  if (destination === 'mode:artifacts' && threadId) {
    return (
      <ArtifactsPanel
        threadId={threadId}
        onSelectArtifact={(artifact) => onOpenSurface(createArtifactSurface({ threadId, artifact }))}
      />
    );
  }
  return <OwnerUnavailable message={`${surface.title} 的 owner 入口当前没有可挂载 renderer。`} />;
}

function WorkspaceDestinationOwnerSurface({
  surface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
  statusSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  statusSurface?: ReactNode;
}) {
  if (isCapabilityEvolutionWorkspaceSurface(surface)) {
    return (
      <CapabilityEvolutionWorkspace
        targetThreadId={resolveCapabilityEvolutionTargetThreadId(surface)}
        onOpenProgram={(programId, displayName, origin) => {
          const programSurface = createEvolutionProgramSurface(programId, displayName, origin);
          onOpenSurface(programSurface);
          useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(programSurface.id);
        }}
      />
    );
  }
  if (surface.objectRef.kind === 'workspace-destination' && surface.objectRef.id === 'surface:files') {
    return <F307FilesOwnerSurface surface={surface} onOpenSurface={onOpenSurface} />;
  }
  if (surface.objectRef.kind === 'workspace-destination' && surface.objectRef.id === 'surface:changes') {
    const changesTarget = resolveChangesTarget(surface);
    return changesTarget ? (
      <ChangesPanel worktreeId={changesTarget.worktreeId} basisPct={40} threadId={changesTarget.threadId} />
    ) : (
      <OwnerUnavailable message="Changes descriptor 没有合法的 F063 worktree owner/result target。" />
    );
  }
  if (surface.objectRef.kind === 'workspace-destination' && surface.objectRef.id === 'mode:team') {
    return <TeamWorkspaceOwnerSurface surface={surface} onRefreshSurface={onRefreshSurface} />;
  }
  return (
    <WorkspaceModeOwnerSurface
      surface={surface}
      onOpenSurface={onOpenSurface}
      onOpenArtifactWithReturn={onOpenArtifactWithReturn}
      onRefreshSurface={onRefreshSurface}
      statusSurface={statusSurface}
    />
  );
}

interface F307OwnerSurfaceRendererProps {
  surface: WorkspaceSurfaceDescriptor;
  surfaceVisible?: boolean;
  statusSurface?: ReactNode;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onRequestDetach: () => void;
}

function F307OwnerSurfaceContent({
  surface,
  statusSurface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
  onRequestDetach,
}: Omit<F307OwnerSurfaceRendererProps, 'surfaceVisible'>) {
  const browserTarget = resolveBrowserTarget(surface);
  const handleBrowserNavigate = useCallback(
    (port: number, path: string) => {
      if (!browserTarget || (browserTarget.port === port && browserTarget.path === path)) return;
      onRefreshSurface(createBrowserSurface({ ownerKey: browserTarget.ownerKey, port, path }));
    },
    [browserTarget, onRefreshSurface],
  );

  if (surface.renderer === 'file-preview' || surface.renderer === 'code-editor') {
    return <F307FileOwnerSurface surface={surface} onRequestDetach={onRequestDetach} />;
  }
  if (surface.renderer === 'content-editor') {
    const contentEditorTarget = resolveContentEditorTarget(surface);
    return contentEditorTarget ? (
      <ContentEditorOwnerSurface target={contentEditorTarget} />
    ) : (
      <OwnerUnavailable message="Content editor descriptor 没有合法的 F309 content/session owner 引用。" />
    );
  }
  if (surface.renderer === 'browser-preview') {
    return browserTarget ? (
      <div
        className="flex min-h-0 min-w-0 w-full flex-1"
        data-owner-preview={browserTarget.ownerKey}
        data-owner-port={browserTarget.port}
        data-owner-path={browserTarget.path}
      >
        <BrowserPanel
          initialPort={browserTarget.port}
          initialPath={browserTarget.path}
          onNavigate={handleBrowserNavigate}
        />
      </div>
    ) : (
      <OwnerUnavailable message="Browser descriptor 没有合法的 F120 owner/result target。" />
    );
  }
  if (surface.renderer === 'terminal-session') {
    const terminalWorktreeId = resolveTerminalWorktreeId(surface);
    return terminalWorktreeId ? (
      <TerminalTab worktreeId={terminalWorktreeId} />
    ) : (
      <OwnerUnavailable message="Terminal descriptor 没有合法 worktree owner。" />
    );
  }
  if (surface.renderer === 'review-summary' && surface.ownerStateRef.owner === 'f309-content-review') {
    const target = resolveArtifactReviewTarget(surface);
    return target ? (
      <ArtifactReviewSurface reviewId={target.reviewId} onBack={onRequestDetach} />
    ) : (
      <OwnerUnavailable message="审阅引用已不可用。" />
    );
  }
  if (surface.renderer === 'artifact-view' || surface.renderer === 'review-summary') {
    return (
      <F307ArtifactOwnerSurface surface={surface} onRequestDetach={onRequestDetach} onOpenSurface={onOpenSurface} />
    );
  }
  if (surface.renderer === 'agent-run') return <AgentRunOwnerSurface surface={surface} />;
  if (surface.renderer === 'evolution-program') {
    const programId = resolveEvolutionProgramId(surface);
    return programId ? (
      <EvolutionProgramSurface programId={programId} />
    ) : (
      <OwnerUnavailable message="Evolution Program descriptor 没有合法的 F311 owner 引用。" />
    );
  }
  if (surface.renderer === 'workspace-destination') {
    return (
      <WorkspaceDestinationOwnerSurface
        surface={surface}
        onOpenSurface={onOpenSurface}
        onOpenArtifactWithReturn={onOpenArtifactWithReturn}
        onRefreshSurface={onRefreshSurface}
        statusSurface={statusSurface}
      />
    );
  }
  return <OwnerUnavailable message="未知 renderer 已 fail closed。" />;
}

export function F307OwnerSurfaceRenderer({ surfaceVisible = true, ...props }: F307OwnerSurfaceRendererProps) {
  return (
    <WorkspaceSurfaceVisibilityProvider visible={surfaceVisible}>
      <F307OwnerSurfaceContent {...props} />
    </WorkspaceSurfaceVisibilityProvider>
  );
}
