'use client';

import type { ReactNode } from 'react';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { ArtifactsPanel } from '@/components/ArtifactsPanel';
import { CommunityPanel } from '@/components/CommunityPanel';
import { CapabilityEvolutionWorkspace } from '@/components/capability-evolution/CapabilityEvolutionWorkspace';
import { EvalWorkspacePanel } from '@/components/eval-workspace/EvalWorkspacePanel';
import { RecallFeed } from '@/components/memory/RecallFeed';
import { TeamWorkspacePanel } from '@/components/routing-context/TeamWorkspacePanel';
import { MailboxApprovalEntry } from '@/components/shell/mailbox/MailboxApprovalEntry';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { TaskBoardPanel } from '@/components/TaskBoardPanel';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { ChangesPanel } from '@/components/workspace/ChangesPanel';
import { GitPanel } from '@/components/workspace/GitPanel';
import { SchedulePanel } from '@/components/workspace/SchedulePanel';
import { TrajectoryPanel } from '@/components/workspace/trajectory/TrajectoryPanel';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { DEFAULT_ARTIFACT_WORK_CHAT_BASIS } from './artifact-work-presentation';
import {
  isCapabilityEvolutionWorkspaceSurface,
  resolveCapabilityEvolutionTargetThreadId,
} from './capability-evolution-workspace-adapter';
import { resolveCommitChangesTarget } from './commit-changes-surface';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { F307FilesOwnerSurface } from './F307FilesOwnerSurface';
import { F307OwnerUnavailable as OwnerUnavailable } from './F307OwnerUnavailable';
import { NeedsMeOwnerSurface, ProductScheduleOwnerSurface } from './GrowingOwnerSurfaces';
import {
  createPullRequestChangesSurface,
  isPullRequestChangesSurfaceCandidate,
  resolvePullRequestChangesTarget,
} from './pull-request-changes-surface';
import {
  createEvolutionProgramSurface,
  createFileSurface,
  createTeamWorkspaceSurface,
  resolveApprovalActionTarget,
  resolveChangesTarget,
  resolveTeamWorkspaceTarget,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import { WorkspaceAuxiliaryOwnerSurface } from './WorkspaceAuxiliaryOwnerSurface';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';

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
  defaultCatId,
  hostWorktreeId,
  hostThreadId,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  statusSurface?: ReactNode;
  defaultCatId?: string;
  hostWorktreeId?: string | null;
  hostThreadId?: string | null;
}) {
  const presentation = useShellPresentation();
  const t = useShellCopy(workspaceChromeCopy);
  const target = resolveWorkspaceDestinationTarget(surface);
  if (!target) return <OwnerUnavailable message="Workspace destination 没有合法 owner/result target。" />;
  const { destinationRef: destination, threadId } = target;
  if (destination === 'host:status') {
    return statusSurface ?? <OwnerUnavailable message="当前 Thread 的状态 owner 暂时不可用。" />;
  }
  if (destination === 'host:now' || destination === 'host:voice' || destination === 'host:films') {
    if (destination === 'host:voice' && !defaultCatId)
      return <OwnerUnavailable message="Voice controls require the original host cat selection." />;
    return (
      <WorkspaceAuxiliaryOwnerSurface
        destination={destination}
        threadId={threadId}
        defaultCatId={defaultCatId ?? ''}
        onOpenSurface={onOpenSurface}
      />
    );
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
    if (presentation === 'v2')
      return <MailboxApprovalEntry proposalId={resolveApprovalActionTarget(surface)?.proposalId ?? null} />;
    return <ApprovalPanel selectedProposalId={resolveApprovalActionTarget(surface)?.proposalId ?? null} />;
  }
  if (destination === 'mode:recall') return <RecallFeed />;
  if (destination === 'mode:eval') return <EvalWorkspacePanel />;
  if (destination === 'mode:community' && threadId) return <CommunityPanel threadId={threadId} />;
  if (destination === 'mode:trajectory') return <TrajectoryPanel threadId={threadId ?? undefined} />;
  if (destination === 'mode:artifacts' && threadId) {
    return (
      <ArtifactsPanel
        key={JSON.stringify([threadId, surface.artifactListView])}
        threadId={threadId}
        initialView={surface.artifactListView}
        onSelectArtifact={(artifact, navigationOrigin, resolvedSurface) => {
          if (artifact.type === 'pr') {
            const target = createPullRequestChangesSurface({
              artifact,
              worktreeId: hostWorktreeId ?? null,
              threadId: hostThreadId ?? null,
              navigationOrigin,
            });
            if (target) onOpenSurface(target);
            else
              useToastStore.getState().addToast({
                type: 'info',
                title: 'PR',
                message: t.pullRequestSourceUnavailable,
                duration: 6000,
              });
            return;
          }
          onOpenSurface(resolvedSurface);
        }}
      />
    );
  }
  return <OwnerUnavailable message={`${surface.title} 的 owner 入口当前没有可挂载 renderer。`} />;
}

export function WorkspaceDestinationOwnerSurface({
  surface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
  onReturnToNavigationOrigin,
  statusSurface,
  defaultCatId,
  hostWorktreeId,
  hostThreadId,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  /** Present when this destination was opened from an entry the person can go back to. */
  onReturnToNavigationOrigin?: () => void;
  statusSurface?: ReactNode;
  defaultCatId?: string;
  hostWorktreeId?: string | null;
  hostThreadId?: string | null;
}) {
  const commitTarget = resolveCommitChangesTarget(surface);
  if (commitTarget)
    return (
      <ChangesPanel
        worktreeId={commitTarget.worktreeId}
        commitTarget={commitTarget}
        basisPct={40}
        onBack={onReturnToNavigationOrigin}
      />
    );
  if (isPullRequestChangesSurfaceCandidate(surface)) {
    const target = resolvePullRequestChangesTarget(surface);
    return target ? (
      <ChangesPanel
        worktreeId={target.worktreeId}
        pullRequestTarget={target}
        chatSource={surface.navigationOrigin?.kind === 'chat-file-link'}
        basisPct={40}
        onBack={onReturnToNavigationOrigin}
      />
    ) : (
      <div className="flex min-h-0 flex-col">
        {onReturnToNavigationOrigin && (
          <button type="button" onClick={onReturnToNavigationOrigin}>
            返回来源
          </button>
        )}
        <OwnerUnavailable message="这个 PR 的精确变更来源已失效。" />
      </div>
    );
  }
  if (isCapabilityEvolutionWorkspaceSurface(surface)) {
    return (
      <CapabilityEvolutionWorkspace
        targetThreadId={resolveCapabilityEvolutionTargetThreadId(surface)}
        onOpenProgram={(programId, displayName, origin) => {
          const programSurface = createEvolutionProgramSurface(programId, displayName, origin);
          onOpenSurface(programSurface);
          const threadId = resolveCapabilityEvolutionTargetThreadId(surface) ?? useChatStore.getState().currentThreadId;
          useF307ExperienceWorkbenchStore
            .getState()
            .enterMainAreaAttention(
              programSurface.id,
              threadId ? { kind: 'chat-workspace', threadId, chatBasis: DEFAULT_ARTIFACT_WORK_CHAT_BASIS } : undefined,
            );
        }}
      />
    );
  }
  if (surface.objectRef.kind === 'workspace-destination' && surface.objectRef.id === 'surface:files') {
    return (
      <F307FilesOwnerSurface
        surface={surface}
        onOpenSurface={onOpenSurface}
        onReturnToNavigationOrigin={onReturnToNavigationOrigin}
      />
    );
  }
  if (surface.objectRef.kind === 'workspace-destination' && surface.objectRef.id === 'surface:changes') {
    const changesTarget = resolveChangesTarget(surface);
    return changesTarget ? (
      <ChangesPanel
        worktreeId={changesTarget.worktreeId}
        basisPct={40}
        threadId={changesTarget.threadId}
        onOpenFile={(path) =>
          onOpenSurface(
            createFileSurface({
              worktreeId: changesTarget.worktreeId,
              path,
              navigationOrigin: { kind: 'workspace-changes', ...changesTarget },
            }),
          )
        }
      />
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
      defaultCatId={defaultCatId}
      hostWorktreeId={hostWorktreeId}
      hostThreadId={hostThreadId}
    />
  );
}
