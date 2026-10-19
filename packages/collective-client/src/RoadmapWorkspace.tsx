import { ShellGlyph } from '@cat-cafe/ui';
import { useState } from 'react';
import { BindingVoteSection } from './BindingVoteCard.js';
import type {
  CollectiveBindingVoteChoice,
  CollectiveBindingVoteProjection,
  CollectiveDecisionRecord,
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import type { ProjectArtifactStatus } from './ProjectArtifactSurface.js';
import { ProjectAttentionPanel } from './ProjectAttentionPanel.js';
import { NewProjectControl } from './ProjectAuthoringForms.js';
import { ProjectBoard } from './ProjectBoard.js';
import { ProjectList } from './ProjectList.js';
import type { ProjectSuggestionDecisionHandler } from './ProjectSuggestionActions.js';
import { NewWorkspaceTaskControl } from './ProjectTaskAuthoring.js';
import { RoadmapPanel } from './RoadmapPanel.js';
import { RoadmapProjection } from './RoadmapProjection.js';
import {
  defaultRoadmapView,
  type ProjectWorkspaceView,
  type RoadmapViewState,
  worksForProjects,
} from './roadmap-view-model.js';
import type { ProjectTaskResponsibility } from './use-collective-collaboration.js';
import type { VoteDraft } from './VoteDraftForm.js';

export function RoadmapWorkspace({
  roadmaps,
  works,
  artifacts = [],
  artifactStatus = 'ready',
  currentHumanId,
  channelId = roadmaps[0]?.sourceLocation.channelId ?? 'general',
  humans = [],
  participants = [],
  humanNames = {},
  view,
  onViewChange,
  onOpenNavigation,
  onOpenSource,
  onOpenResult,
  onOpenArtifact,
  onSetDependencies,
  onSetStatus,
  onCreateProject,
  onCreateProjectTask,
  onCommitWork,
  onRequestWorkAccountability,
  onRespondWorkAccountability,
  onDecideProjectSuggestion,
  bindingVotes,
  decisions,
  onCreateBindingVote,
  onCastBindingVote,
  onWithdrawBindingVote,
  onSettleBindingVote,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly artifacts?: readonly SharedArtifact[];
  readonly artifactStatus?: ProjectArtifactStatus;
  readonly currentHumanId: string;
  readonly channelId?: string;
  readonly humans?: CollectiveMemberDirectory['humans'];
  readonly participants?: readonly CollectiveParticipant[];
  readonly humanNames?: Readonly<Record<string, string>>;
  readonly view?: RoadmapViewState;
  readonly onViewChange?: (view: RoadmapViewState) => void;
  readonly onOpenNavigation?: () => void;
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenResult?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenArtifact?: (artifact: SharedArtifact) => void;
  readonly onSetDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) => void;
  readonly onSetStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') => void;
  readonly onCreateProject?: (channelId: string, title: string, purpose: string) => Promise<void>;
  readonly onCreateProjectTask?: (
    roadmap: CollectiveRoadmapRecord,
    channelId: string,
    title: string,
    intendedOutcome: string,
    responsibility: ProjectTaskResponsibility,
  ) => Promise<void>;
  readonly onCommitWork?: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => Promise<void>;
  readonly onRequestWorkAccountability?: (
    roadmap: CollectiveRoadmapRecord,
    work: CollectiveWorkProjection,
    targetHumanId: string,
  ) => Promise<void>;
  readonly onRespondWorkAccountability?: (
    work: CollectiveWorkProjection,
    request: NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number],
    decision: 'accept' | 'decline',
    participant?: CollectiveParticipant,
  ) => Promise<void>;
  readonly onDecideProjectSuggestion?: ProjectSuggestionDecisionHandler;
  readonly bindingVotes: readonly CollectiveBindingVoteProjection[];
  readonly decisions: readonly CollectiveDecisionRecord[];
  readonly onCreateBindingVote: (roadmap: CollectiveRoadmapRecord, draft: VoteDraft) => Promise<void>;
  readonly onCastBindingVote: (vote: CollectiveBindingVoteProjection, choice: CollectiveBindingVoteChoice) => void;
  readonly onWithdrawBindingVote: (vote: CollectiveBindingVoteProjection) => void;
  readonly onSettleBindingVote: (vote: CollectiveBindingVoteProjection) => void;
}) {
  const [internalView, setInternalView] = useState<RoadmapViewState>(() => ({
    ...defaultRoadmapView,
    roadmapId: roadmaps[0]?.roadmapId,
  }));
  const activeView = view ?? internalView;
  const workspace = activeView.workspace ?? 'list';
  const selected = roadmaps.find((roadmap) => roadmap.roadmapId === activeView.roadmapId) ?? roadmaps[0];
  const updateView = (next: RoadmapViewState) => {
    if (!view) setInternalView(next);
    onViewChange?.(next);
  };
  const openProject = (roadmap: CollectiveRoadmapRecord, work?: CollectiveWorkProjection) =>
    updateView({
      ...defaultRoadmapView,
      workspace: 'project',
      roadmapId: roadmap.roadmapId,
      ...(work ? { workId: work.workId } : {}),
    });
  const openProjectWork = (work: CollectiveWorkProjection) => {
    const currentRoadmap = roadmaps.find(
      (candidate) => candidate.roadmapId === activeView.roadmapId && candidate.workIds.includes(work.workId),
    );
    const roadmap = currentRoadmap ?? roadmaps.find((candidate) => candidate.workIds.includes(work.workId));
    if (roadmap) openProject(roadmap, work);
  };
  const switchWorkspace = (next: Exclude<ProjectWorkspaceView, 'project'>) =>
    updateView({ ...defaultRoadmapView, workspace: next, roadmapId: activeView.roadmapId });
  const projectWorks = worksForProjects(roadmaps, works);

  if (workspace === 'project' && selected) {
    return (
      <div className="roadmap-workspace" data-project-page>
        <RoadmapPanel
          roadmap={selected}
          allRoadmaps={roadmaps}
          works={works}
          artifacts={artifacts}
          artifactStatus={artifactStatus}
          currentHumanId={currentHumanId}
          channelId={channelId}
          humans={humans}
          participants={participants}
          humanNames={humanNames}
          view={{ ...activeView, roadmapId: selected.roadmapId }}
          onViewChange={updateView}
          onOpenNavigation={onOpenNavigation}
          onBack={() => switchWorkspace('list')}
          onOpenSource={onOpenSource}
          onOpenResult={onOpenResult}
          onOpenArtifact={onOpenArtifact}
          onSetDependencies={onSetDependencies}
          onSetStatus={onSetStatus}
          onCreateTask={onCreateProjectTask}
          onCommitWork={onCommitWork}
          onRequestWorkAccountability={onRequestWorkAccountability}
          onRespondWorkAccountability={onRespondWorkAccountability}
          onDecideProjectSuggestion={onDecideProjectSuggestion}
        />
        <BindingVoteSection
          roadmap={selected}
          votes={bindingVotes}
          decisions={decisions}
          currentHumanId={currentHumanId}
          onCreate={onCreateBindingVote}
          onCast={onCastBindingVote}
          onWithdraw={onWithdrawBindingVote}
          onSettle={onSettleBindingVote}
        />
      </div>
    );
  }

  return (
    <div className="roadmap-workspace">
      <section className="project-workspace-heading" aria-label="项目总览导航">
        <div className="project-workspace-title">
          {onOpenNavigation && (
            <button type="button" className="mobile-navigation" aria-label="频道导航" onClick={onOpenNavigation}>
              <ShellGlyph name="panelLeft" />
            </button>
          )}
          <h1>项目</h1>
          <span>{roadmaps.filter((roadmap) => roadmap.status === 'active').length} 个进行中</span>
        </div>
        <nav aria-label="项目视图">
          <ProjectViewButton active={workspace === 'list'} onClick={() => switchWorkspace('list')}>
            项目列表
          </ProjectViewButton>
          <ProjectViewButton active={workspace === 'dependencies'} onClick={() => switchWorkspace('dependencies')}>
            跨项目依赖
          </ProjectViewButton>
          <ProjectViewButton active={workspace === 'board'} onClick={() => switchWorkspace('board')}>
            看板
          </ProjectViewButton>
        </nav>
        {workspace === 'list' ? (
          <NewProjectControl channelId={channelId} onCreate={onCreateProject} />
        ) : (
          <NewWorkspaceTaskControl
            roadmaps={roadmaps}
            channelId={channelId}
            currentHumanId={currentHumanId}
            humans={humans}
            onCreate={onCreateProjectTask}
          />
        )}
      </section>
      {workspace === 'list' && (
        <ProjectAttentionPanel
          roadmaps={roadmaps}
          works={works}
          humans={humans}
          humanNames={humanNames}
          currentHumanId={currentHumanId}
          onOpen={openProject}
        />
      )}
      {workspace === 'list' ? (
        <ProjectList
          roadmaps={roadmaps}
          works={works}
          artifacts={artifacts}
          artifactStatus={artifactStatus}
          currentHumanId={currentHumanId}
          humans={humans}
          participants={participants}
          humanNames={humanNames}
          onOpen={openProject}
          onOpenArtifact={onOpenArtifact}
        />
      ) : workspace === 'dependencies' ? (
        <div className="project-dependencies">
          <RoadmapProjection
            works={projectWorks}
            allWorks={works}
            view={{ ...activeView, lens: 'dependencies', scope: 'all' }}
            currentHumanId={currentHumanId}
            humanNames={humanNames}
            onSelect={(workId) => {
              const work = works.find((candidate) => candidate.workId === workId);
              if (work) openProjectWork(work);
            }}
          />
        </div>
      ) : workspace === 'board' ? (
        <ProjectBoard
          roadmaps={roadmaps}
          works={works}
          availableWorks={works}
          currentHumanId={currentHumanId}
          humans={humans}
          participants={participants}
          humanNames={humanNames}
          onSelect={openProjectWork}
          onCommitWork={onCommitWork}
          onRequestWorkAccountability={onRequestWorkAccountability}
          onRespondWorkAccountability={onRespondWorkAccountability}
        />
      ) : (
        <p className="project-workspace-empty">还没有项目。新建项目后，任务、负责人和结果会留在同一条路径里。</p>
      )}
    </div>
  );
}

function ProjectViewButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button type="button" aria-current={active ? 'page' : undefined} onClick={onClick}>
      {children}
    </button>
  );
}
