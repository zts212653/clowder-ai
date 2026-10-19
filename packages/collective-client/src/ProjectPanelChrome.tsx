import type { CollectiveMemberDirectory, CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { HumanIdentityChip } from './ProjectIdentityChip.js';
import { NewProjectTaskControl } from './ProjectTaskAuthoring.js';
import type { RoadmapLens, RoadmapViewState } from './roadmap-view-model.js';
import type { ProjectTaskResponsibility } from './use-collective-collaboration.js';

export function ProjectPageToolbar({
  roadmap,
  channelId,
  currentHumanId,
  humans,
  view,
  onOpenNavigation,
  onBack,
  onSetLens,
  onCreateTask,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly channelId: string;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly view: RoadmapViewState;
  readonly onOpenNavigation?: () => void;
  readonly onBack: () => void;
  readonly onSetLens: (lens: RoadmapLens, presentation?: RoadmapViewState['presentation']) => void;
  readonly onCreateTask?: (
    roadmap: CollectiveRoadmapRecord,
    channelId: string,
    title: string,
    intendedOutcome: string,
    responsibility: ProjectTaskResponsibility,
  ) => Promise<void>;
}) {
  return (
    <header className="project-page-toolbar">
      <div className="project-page-location">
        {onOpenNavigation && (
          <button type="button" className="mobile-navigation" aria-label="频道导航" onClick={onOpenNavigation}>
            <ShellGlyph name="panelLeft" />
          </button>
        )}
        <nav className="project-breadcrumb" aria-label="项目层级">
          <button type="button" onClick={onBack}>
            项目
          </button>
          <span aria-hidden="true">›</span>
          <strong>{roadmap.title}</strong>
        </nav>
      </div>
      <ProjectViewNavigation view={view} onSetLens={onSetLens} />
      <NewProjectTaskControl
        roadmap={roadmap}
        channelId={channelId}
        currentHumanId={currentHumanId}
        humans={humans}
        onCreate={onCreateTask}
      />
    </header>
  );
}

export function ProjectPanelSummary({
  roadmap,
  works,
  currentHumanId,
  humans,
  humanNames,
  canChangeStatus,
  onSetStatus,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly canChangeStatus: boolean;
  readonly onSetStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') => void;
}) {
  const completed = works.filter((work) => work.lifecycle === 'completed').length;
  const blocked = works.filter((work) => work.status === 'blocked').length;
  const unassigned = works.filter((work) => work.status === 'unassigned').length;
  return (
    <section className="project-summary" aria-label={`项目 · ${roadmap.title}`}>
      <div>
        <span className="project-summary-status">{roadmap.status === 'active' ? '进行中' : '已完成'}</span>
        <h1>{roadmap.title}</h1>
        <p>{roadmap.purpose}</p>
      </div>
      <dl>
        <div>
          <dt>负责人</dt>
          <dd>
            <HumanIdentityChip
              humanId={roadmap.accountableHumanId}
              humans={humans}
              fallbackName={humanNames[roadmap.accountableHumanId] ?? '共同体成员'}
            />
          </dd>
        </div>
        <div>
          <dt>进度</dt>
          <dd>
            {works.length} 项 · {completed} 完成
            {blocked ? ` · ${blocked} 阻塞` : ''}
            {unassigned ? ` · ${unassigned} 未分配` : ''}
          </dd>
        </div>
      </dl>
      {roadmap.accountableHumanId === currentHumanId && canChangeStatus && (
        <button
          type="button"
          className="roadmap-status-action"
          onClick={() => onSetStatus(roadmap, roadmap.status === 'active' ? 'completed' : 'active')}
        >
          {roadmap.status === 'active' ? '完成项目' : '重新打开项目'}
        </button>
      )}
    </section>
  );
}

export function ProjectViewNavigation({
  view,
  onSetLens,
}: {
  readonly view: RoadmapViewState;
  readonly onSetLens: (lens: RoadmapLens, presentation?: RoadmapViewState['presentation']) => void;
}) {
  return (
    <nav className="project-view-navigation" aria-label="项目观察方式">
      <LensButton
        active={view.lens === 'stage' && view.presentation === 'graph'}
        onClick={() => onSetLens('stage', 'graph')}
      >
        计划
      </LensButton>
      <LensButton
        active={view.lens === 'stage' && view.presentation === 'board'}
        onClick={() => onSetLens('stage', 'board')}
      >
        看板
      </LensButton>
      <LensButton active={view.lens === 'dependencies'} onClick={() => onSetLens('dependencies')}>
        依赖图
      </LensButton>
      <LensButton active={view.lens === 'artifacts'} onClick={() => onSetLens('artifacts')}>
        作品
      </LensButton>
    </nav>
  );
}

function LensButton({
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

import { ShellGlyph } from '@cat-cafe/ui';
