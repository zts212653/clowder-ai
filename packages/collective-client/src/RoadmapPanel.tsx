import { type ReactNode, useState } from 'react';
import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import { type ProjectArtifactStatus, ProjectArtifactSurface } from './ProjectArtifactSurface.js';
import { ProjectBoard } from './ProjectBoard.js';
import { ProjectContextPanel } from './ProjectContextPanel.js';
import { useProjectMaterials } from './ProjectMaterialsContext.js';
import { ProjectPageToolbar, ProjectPanelSummary } from './ProjectPanelChrome.js';
import { ProjectPlanTable } from './ProjectPlanTable.js';
import { ProjectSuggestionActions, type ProjectSuggestionDecisionHandler } from './ProjectSuggestionActions.js';
import type { ProjectTargetChangeHandler } from './ProjectTimeSummary.js';
import { ProjectTriagePanel } from './ProjectTriagePanel.js';
import { RoadmapProjection } from './RoadmapProjection.js';
import { RoadmapWorkDetails } from './RoadmapWorkDetails.js';
import {
  canCompleteProject,
  type RoadmapLens,
  type RoadmapViewState,
  visibleRoadmapWorks,
  worksForRoadmap,
} from './roadmap-view-model.js';
import { ShareMaterialDialog } from './ShareMaterialDialog.js';
import type { ProjectTaskResponsibility } from './use-collective-collaboration.js';
import type { WorkTimeChangeHandler } from './WorkTimeEditor.js';

export function RoadmapPanel({
  roadmap,
  allRoadmaps = [roadmap],
  works,
  artifacts = [],
  artifactStatus = 'ready',
  currentHumanId,
  channelId = roadmap.sourceLocation.channelId,
  humans = [],
  participants = [],
  humanNames = {},
  view,
  onViewChange,
  onOpenNavigation,
  onBack,
  onChangeWorkTime,
  onChangeProjectTarget,
  onSetDependencies,
  onSetStatus,
  onCreateTask,
  onCommitWork,
  onRequestWorkAccountability,
  onRespondWorkAccountability,
  onDecideProjectSuggestion,
  onOpenSource,
  onOpenResult,
  onOpenArtifact,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly allRoadmaps?: readonly CollectiveRoadmapRecord[];
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
  readonly onBack?: () => void;
  readonly onChangeWorkTime?: WorkTimeChangeHandler;
  readonly onChangeProjectTarget?: ProjectTargetChangeHandler;
  readonly onSetDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) => void;
  readonly onSetStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') => void;
  readonly onCreateTask?: (
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
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenResult?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenArtifact?: (
    artifact: SharedArtifact,
    ownerRevision?: number,
    options?: import('./collective-artifact-client.js').SharedArtifactOpenOptions,
  ) => void;
}) {
  const [internalView, setInternalView] = useState<RoadmapViewState>({
    lens: 'stage',
    presentation: 'graph',
    scope: 'all',
    relation: 'all',
  });
  const activeView = view ?? internalView;
  const updateView = (next: RoadmapViewState) => {
    if (!view) setInternalView(next);
    onViewChange?.(next);
  };
  const materialFeed = useProjectMaterials(roadmap.roadmapId);
  const [sharingMaterial, setSharingMaterial] = useState(false);
  const routeWorks = worksForRoadmap(roadmap, works);
  const visibleWorks = visibleRoadmapWorks(routeWorks, activeView, currentHumanId);
  const selectedWork = activeView.workId ? routeWorks.find((work) => work.workId === activeView.workId) : undefined;
  const setLens = (lens: RoadmapLens, presentation = activeView.presentation) =>
    updateView({
      ...activeView,
      lens,
      presentation,
      workId: lens === 'artifacts' || lens === 'triage' ? undefined : activeView.workId,
      ...(lens === 'dependencies' || (lens === 'stage' && presentation === 'graph')
        ? { scope: 'all', relation: 'all' as const }
        : {}),
    });
  const canChangeStatus = roadmap.status === 'completed' || canCompleteProject(roadmap, routeWorks);
  const unfinishedCount = visibleRoadmapWorks(
    routeWorks,
    { ...activeView, lens: 'stage', scope: 'unfinished', relation: 'all' },
    currentHumanId,
  ).length;
  const mineCount = visibleRoadmapWorks(
    routeWorks,
    { ...activeView, lens: 'stage', scope: 'all', relation: 'mine' },
    currentHumanId,
  ).length;
  const isPlan = activeView.lens === 'stage' && activeView.presentation === 'graph';
  const isBoard = activeView.lens === 'stage' && activeView.presentation === 'board';
  return (
    <section className="roadmap-panel" aria-label={`项目页面 · ${roadmap.title}`}>
      <ProjectPageToolbar
        roadmap={roadmap}
        channelId={channelId}
        currentHumanId={currentHumanId}
        humans={humans}
        view={activeView}
        onOpenNavigation={onOpenNavigation}
        onBack={onBack ?? (() => undefined)}
        onSetLens={setLens}
        materialCount={materialFeed.feed.pendingCount}
        hasMaterials={
          materialFeed.feed.items.length + materialFeed.feed.unavailable.length > 0 || activeView.lens === 'triage'
        }
        onShareMaterial={materialFeed.client ? () => setSharingMaterial(true) : undefined}
        onCreateTask={onCreateTask}
      />
      <div className="project-page-body">
        <main className="project-page-main">
          <ProjectPanelSummary
            roadmap={roadmap}
            works={routeWorks}
            currentHumanId={currentHumanId}
            humans={humans}
            humanNames={humanNames}
            canChangeStatus={canChangeStatus}
            onChangeTarget={onChangeProjectTarget}
            onSetStatus={onSetStatus}
          />
          <ProjectSuggestionActions
            roadmap={roadmap}
            works={works}
            currentHumanId={currentHumanId}
            onDecide={onDecideProjectSuggestion}
          />
          {(isPlan || activeView.lens === 'dependencies') && (
            <div className="roadmap-context-bar">
              <ControlGroup label="项目筛选">
                <ControlButton
                  active={activeView.relation !== 'mine' && activeView.scope === 'all'}
                  onClick={() => updateView({ ...activeView, relation: 'all', scope: 'all' })}
                >
                  {`全部 ${routeWorks.length}`}
                </ControlButton>
                <ControlButton
                  active={activeView.relation !== 'mine' && activeView.scope === 'unfinished'}
                  onClick={() => updateView({ ...activeView, relation: 'all', scope: 'unfinished' })}
                >
                  {`未完成 ${unfinishedCount}`}
                </ControlButton>
                <ControlButton
                  active={activeView.relation === 'mine'}
                  onClick={() => updateView({ ...activeView, relation: 'mine', scope: 'all' })}
                >
                  {`与我相关 ${mineCount}`}
                </ControlButton>
              </ControlGroup>
            </div>
          )}
          {activeView.lens === 'triage' ? (
            <ProjectTriagePanel
              project={roadmap}
              works={works}
              currentHumanId={currentHumanId}
              feed={materialFeed}
              view={activeView}
              onOpenWork={(workId) => updateView({ ...activeView, workId })}
            />
          ) : activeView.lens === 'artifacts' ? (
            <ProjectArtifactSurface
              roadmap={roadmap}
              works={routeWorks}
              artifacts={artifacts}
              status={artifactStatus}
              onOpen={onOpenArtifact}
            />
          ) : isBoard ? (
            <ProjectBoard
              roadmaps={[roadmap]}
              allRoadmaps={allRoadmaps}
              works={routeWorks}
              availableWorks={works}
              currentHumanId={currentHumanId}
              humans={humans}
              participants={participants}
              humanNames={humanNames}
              onSelect={(work) => updateView({ ...activeView, workId: work.workId })}
              onCommitWork={onCommitWork}
              onRequestWorkAccountability={onRequestWorkAccountability}
              onRespondWorkAccountability={onRespondWorkAccountability}
            />
          ) : isPlan ? (
            <ProjectPlanTable
              roadmap={roadmap}
              allRoadmaps={allRoadmaps}
              works={visibleWorks}
              availableWorks={works}
              currentHumanId={currentHumanId}
              humans={humans}
              participants={participants}
              humanNames={humanNames}
              selectedWorkId={selectedWork?.workId}
              onSelect={(workId) => updateView({ ...activeView, workId })}
              onCommitWork={onCommitWork}
              onRequestWorkAccountability={onRequestWorkAccountability}
              onRespondWorkAccountability={onRespondWorkAccountability}
            />
          ) : visibleWorks.length ? (
            <div className="roadmap-canvas" data-concierge-safe-zone>
              <RoadmapProjection
                works={visibleWorks}
                allWorks={works}
                view={activeView}
                currentHumanId={currentHumanId}
                humanNames={humanNames}
                selectedWorkId={selectedWork?.workId}
                onSelect={(workId) => updateView({ ...activeView, workId })}
              />
            </div>
          ) : (
            <p className="roadmap-empty">
              {activeView.relation === 'mine' ? '这个项目还没有与你相关的任务。' : '当前筛选下没有任务。'}
            </p>
          )}
        </main>
        <ProjectContextPanel
          materialFeed={materialFeed}
          roadmap={roadmap}
          works={routeWorks}
          availableWorks={works}
          view={activeView}
          onOpenSource={onOpenSource}
        />
      </div>
      {selectedWork && (
        <RoadmapWorkDetails
          materialFeed={materialFeed}
          work={selectedWork}
          roadmap={roadmap}
          allRoadmaps={allRoadmaps}
          availableWorks={works}
          view={activeView}
          currentHumanId={currentHumanId}
          humanNames={humanNames}
          humans={humans}
          participants={participants}
          onChangeTime={onChangeWorkTime}
          canEditDependencies={roadmap.status === 'active'}
          onSetDependencies={onSetDependencies}
          onCommitWork={onCommitWork}
          onRequestWorkAccountability={onRequestWorkAccountability}
          onRespondWorkAccountability={onRespondWorkAccountability}
          onOpenSource={onOpenSource}
          onOpenResult={onOpenResult}
          onClose={() => updateView({ ...activeView, workId: undefined })}
        />
      )}
      {sharingMaterial && materialFeed.client && (
        <ShareMaterialDialog
          project={roadmap}
          client={materialFeed.client}
          onClose={() => setSharingMaterial(false)}
          onShared={async () => {
            await materialFeed.reload();
            updateView({ ...activeView, lens: 'triage', workId: undefined });
          }}
        />
      )}
    </section>
  );
}

function ControlGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <fieldset className="roadmap-control-group" aria-label={label}>
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

function ControlButton({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}
