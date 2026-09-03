'use client';

import { type ReactNode, useCallback } from 'react';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { ArtifactsPanel } from '@/components/ArtifactsPanel';
import { ArtifactDetailView } from '@/components/artifacts/ArtifactDetailView';
import { CommunityPanel } from '@/components/CommunityPanel';
import { CapabilityEvolutionWorkspace } from '@/components/capability-evolution/CapabilityEvolutionWorkspace';
import { EvolutionProgramSurface } from '@/components/capability-evolution/EvolutionProgramSurface';
import { EvalWorkspacePanel } from '@/components/eval-workspace/EvalWorkspacePanel';
import { NeedsMePanel } from '@/components/growing/NeedsMePanel';
import { type PreparedArtifactCoordinate, ProductSchedulePanel } from '@/components/growing/ProductSchedulePanel';
import { RecallFeed } from '@/components/memory/RecallFeed';
import { TeamWorkspacePanel } from '@/components/routing-context/TeamWorkspacePanel';
import { TaskBoardPanel } from '@/components/TaskBoardPanel';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { BrowserPanel } from '@/components/workspace/BrowserPanel';
import { ChangesPanel } from '@/components/workspace/ChangesPanel';
import { GitPanel } from '@/components/workspace/GitPanel';
import { SchedulePanel } from '@/components/workspace/SchedulePanel';
import { TerminalTab } from '@/components/workspace/TerminalTab';
import { TrajectoryPanel } from '@/components/workspace/trajectory/TrajectoryPanel';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { navigateToEntrustedWorkAction, resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { isCapabilityEvolutionWorkspaceSurface } from './capability-evolution-workspace-adapter';
import { F307FileOwnerSurface } from './F307FileOwnerSurface';
import { F307FilesOwnerSurface } from './F307FilesOwnerSurface';
import {
  artifactObjectId,
  createApprovalActionSurface,
  createArtifactSurface,
  createBrowserSurface,
  createEvolutionProgramSurface,
  createNeedsMeReturnSurface,
  createProductScheduleReturnSurface,
  createTeamWorkspaceSurface,
  resolveAgentRunTarget,
  resolveApprovalActionTarget,
  resolveArtifactTarget,
  resolveBrowserTarget,
  resolveChangesTarget,
  resolveEvolutionProgramId,
  resolveNeedsMeReturnTarget,
  resolveProductScheduleReturnTarget,
  resolveTeamWorkspaceTarget,
  resolveTerminalWorktreeId,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';

function OwnerUnavailable({ message }: { message: string }) {
  return (
    <div className="grid h-full min-h-52 place-items-center p-6 text-center" data-testid="f307-owner-unavailable">
      <div>
        <p className="text-sm font-semibold text-cafe">这个对象目前无法恢复</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-cafe-muted">{message}</p>
      </div>
    </div>
  );
}

function ArtifactOwnerSurface({
  surface,
  onRequestDetach,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onRequestDetach: () => void;
}) {
  const target = resolveArtifactTarget(surface);
  const { artifacts, loading, error } = useThreadArtifacts(target?.threadId);
  const hostThreadId = useChatStore((state) => state.currentThreadId);
  const hostWorktreeId = useChatStore((state) => state.workspaceWorktreeId);
  if (!target) return <OwnerUnavailable message="Artifact descriptor 没有合法的 F232 owner 引用。" />;
  if (loading) return <div className="p-5 text-xs text-cafe-muted">正在从原 Thread 恢复产物…</div>;
  if (error) return <OwnerUnavailable message="F232 产物 owner 暂时不可用；Workbench 没有猜测或复制内容。" />;
  const artifact = artifacts.find((candidate) => artifactObjectId(candidate) === target.artifactId);
  if (!artifact) return <OwnerUnavailable message="原 owner 已找不到这个产物；其余 Workbench surface 保持可用。" />;
  return (
    <ArtifactDetailView
      artifact={artifact}
      worktreeId={target.threadId === hostThreadId ? hostWorktreeId : null}
      onBack={onRequestDetach}
      onJump={(messageId) => scrollToMessage(messageId)}
    />
  );
}

function AgentRunOwnerSurface({ surface }: { surface: WorkspaceSurfaceDescriptor }) {
  const target = resolveAgentRunTarget(surface);
  if (!target) return <OwnerUnavailable message="Agent Run descriptor 没有合法的 F299 invocation 引用。" />;
  return <TrajectoryPanel threadId={target.threadId} targetOverride={target} />;
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
      onSubjectChange={(subject) => {
        setTeamWorkspaceSubject(subject);
        onRefreshSurface(createTeamWorkspaceSurface({ threadId: target.threadId ?? undefined, subject }));
      }}
    />
  );
}

function ProductScheduleOwnerSurface({
  surface,
  onOpenArtifactWithReturn,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
}) {
  const { artifacts } = useGlobalArtifacts(true);
  const selectedItemRef = resolveProductScheduleReturnTarget(surface)?.itemRef ?? null;
  const openArtifact = useCallback(
    (coordinate: PreparedArtifactCoordinate, itemRef: string) => {
      const matches = artifacts.filter((artifact) => (artifact.ref ?? artifact.url) === coordinate.artifactRef);
      const artifact = matches.length === 1 ? matches[0] : undefined;
      const returnSurface = createProductScheduleReturnSurface(surface, itemRef);
      if (!artifact || !returnSurface) return;
      onOpenArtifactWithReturn({
        artifact: createArtifactSurface({ threadId: artifact.threadId, artifact }),
        returnSurface,
      });
    },
    [artifacts, onOpenArtifactWithReturn, surface],
  );
  return <ProductSchedulePanel selectedItemRef={selectedItemRef} onOpenArtifact={openArtifact} />;
}

function NeedsMeOwnerSurface({
  surface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
}: {
  surface: WorkspaceSurfaceDescriptor;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  const { artifacts } = useGlobalArtifacts(true);
  const selectedItemRef = resolveNeedsMeReturnTarget(surface)?.itemRef ?? null;
  const returnSurface = useCallback((itemRef: string) => createNeedsMeReturnSurface(surface, itemRef), [surface]);
  const openArtifact = useCallback(
    (coordinate: PreparedArtifactCoordinate, itemRef: string) => {
      const matches = artifacts.filter((artifact) => (artifact.ref ?? artifact.url) === coordinate.artifactRef);
      const artifact = matches.length === 1 ? matches[0] : undefined;
      const selectedSurface = returnSurface(itemRef);
      if (!artifact || !selectedSurface) return;
      onOpenArtifactWithReturn({
        artifact: createArtifactSurface({ threadId: artifact.threadId, artifact }),
        returnSurface: selectedSurface,
      });
    },
    [artifacts, onOpenArtifactWithReturn, returnSurface],
  );
  const openAction = useCallback(
    (actionRef: string, itemRef: string) => {
      const selectedSurface = returnSurface(itemRef);
      if (!selectedSurface) return;
      const target = resolveEntrustedWorkActionTarget(actionRef);
      if (!target) return;
      onRefreshSurface(selectedSurface);
      if (target.kind === 'message') {
        navigateToEntrustedWorkAction(actionRef);
        return;
      }
      const approvalSurface = createApprovalActionSurface(selectedSurface, target.proposalId);
      if (approvalSurface) onOpenSurface(approvalSurface);
    },
    [onOpenSurface, onRefreshSurface, returnSurface],
  );
  return (
    <NeedsMePanel
      artifacts={artifacts}
      selectedItemRef={selectedItemRef}
      onOpenArtifact={openArtifact}
      onOpenAction={openAction}
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
        onOpenProgram={(programId) => onOpenSurface(createEvolutionProgramSurface(programId))}
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

export function F307OwnerSurfaceRenderer({
  surface,
  statusSurface,
  onOpenSurface,
  onOpenArtifactWithReturn,
  onRefreshSurface,
  onRequestDetach,
}: {
  surface: WorkspaceSurfaceDescriptor;
  statusSurface?: ReactNode;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onOpenArtifactWithReturn: (input: {
    artifact: WorkspaceSurfaceDescriptor;
    returnSurface: WorkspaceSurfaceDescriptor;
  }) => void;
  onRefreshSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  onRequestDetach: () => void;
}) {
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
  if (surface.renderer === 'artifact-view' || surface.renderer === 'review-summary') {
    return <ArtifactOwnerSurface surface={surface} onRequestDetach={onRequestDetach} />;
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
