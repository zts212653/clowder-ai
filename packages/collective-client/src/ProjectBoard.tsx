import { useState } from 'react';
import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import { ProjectBoardCard } from './ProjectBoardCard.js';
import { AgentIdentityChip, HumanIdentityChip } from './ProjectIdentityChip.js';
import {
  type ProjectBoardColumn,
  type ProjectBoardGrouping,
  projectBoardColumn,
  projectBoardLanes,
  worksForProjects,
} from './roadmap-view-model.js';

const columns: readonly { readonly id: ProjectBoardColumn; readonly label: string }[] = [
  { id: 'queued', label: '待开始' },
  { id: 'in_progress', label: '进行中' },
  { id: 'result_ready', label: '待确认' },
  { id: 'completed', label: '已完成' },
];
type BoardFilter = 'all' | 'mine' | 'blocked' | 'result_ready';

export function ProjectBoard({
  roadmaps,
  allRoadmaps = roadmaps,
  works,
  availableWorks = works,
  currentHumanId = '',
  humans = [],
  participants = [],
  humanNames,
  onSelect,
  onCommitWork,
  onRequestWorkAccountability,
  onRespondWorkAccountability,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly allRoadmaps?: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly availableWorks?: readonly CollectiveWorkProjection[];
  readonly currentHumanId?: string;
  readonly humans?: CollectiveMemberDirectory['humans'];
  readonly participants?: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly onSelect: (work: CollectiveWorkProjection) => void;
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
}) {
  const [grouping, setGrouping] = useState<ProjectBoardGrouping>('executor');
  const [filter, setFilter] = useState<BoardFilter>('all');
  const projectWorks = worksForProjects(roadmaps, works);
  const mine = projectWorks.filter(
    (work) => work.accountableHumanId === currentHumanId || work.assignment?.humanId === currentHumanId,
  );
  const blocked = projectWorks.filter((work) => work.status === 'blocked');
  const resultReady = projectWorks.filter((work) => work.status === 'result_ready');
  const filtered =
    filter === 'mine' ? mine : filter === 'blocked' ? blocked : filter === 'result_ready' ? resultReady : projectWorks;
  const lanes = projectBoardLanes(grouping, roadmaps, filtered, humanNames);
  const projectsByWork = projectRecordsForWorks(roadmaps);
  return (
    <section className="project-board" aria-label="项目看板">
      <div className="project-board-toolbar">
        <nav aria-label="看板筛选">
          <BoardFilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
            {`全部任务 ${projectWorks.length}`}
          </BoardFilterButton>
          <BoardFilterButton active={filter === 'mine'} onClick={() => setFilter('mine')}>
            {`与我相关 ${mine.length}`}
          </BoardFilterButton>
          <BoardFilterButton active={filter === 'blocked'} onClick={() => setFilter('blocked')}>
            {`被阻塞 ${blocked.length}`}
          </BoardFilterButton>
          <BoardFilterButton active={filter === 'result_ready'} onClick={() => setFilter('result_ready')}>
            {`待确认 ${resultReady.length}`}
          </BoardFilterButton>
        </nav>
        <details className="project-board-grouping" aria-label="看板显示设置">
          <summary aria-label="更改看板分组">显示设置 · 泳道按{groupingLabels[grouping]}</summary>
          <div>
            {(['executor', 'accountable', 'project'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-current={candidate === grouping ? 'true' : undefined}
                onClick={() => setGrouping(candidate)}
              >
                按{groupingLabels[candidate]}
              </button>
            ))}
          </div>
        </details>
      </div>
      <header className="project-board-columns">
        <span />
        {columns.map((column) => (
          <div key={column.id} data-project-column={column.id}>
            <header>
              <strong>{column.label}</strong>
              <span>{filtered.filter((work) => projectBoardColumn(work) === column.id).length}</span>
            </header>
          </div>
        ))}
      </header>
      {lanes.length ? (
        lanes.map((lane) => (
          <section
            key={lane.id}
            className="project-board-lane"
            data-project-lane={lane.id}
            data-unassigned={lane.unassigned || undefined}
            aria-label={`${lane.label}的任务`}
          >
            <header>
              <LaneIdentity
                grouping={grouping}
                works={lane.works}
                label={lane.label}
                humans={humans}
                participants={participants}
                humanNames={humanNames}
              />
              {lane.accountableLabel && <span>负责人 {lane.accountableLabel}</span>}
              <small>{lane.works.length} 项</small>
            </header>
            {columns.map((column) => (
              <div key={column.id} className="project-board-cell" data-project-column={column.id}>
                {lane.works
                  .filter((work) => projectBoardColumn(work) === column.id)
                  .map((work) => (
                    <ProjectBoardCard
                      key={work.workId}
                      work={work}
                      availableWorks={availableWorks}
                      projectWorks={projectWorks}
                      projects={projectsByWork.get(work.workId) ?? []}
                      allRoadmaps={allRoadmaps}
                      currentHumanId={currentHumanId}
                      humans={humans}
                      participants={participants}
                      humanNames={humanNames}
                      onSelect={onSelect}
                      onCommitWork={onCommitWork}
                      onRequestWorkAccountability={onRequestWorkAccountability}
                      onRespondWorkAccountability={onRespondWorkAccountability}
                    />
                  ))}
              </div>
            ))}
          </section>
        ))
      ) : (
        <p className="project-board-empty">当前筛选下没有任务。</p>
      )}
    </section>
  );
}

const groupingLabels: Record<ProjectBoardGrouping, string> = {
  executor: '执行',
  accountable: '负责人',
  project: '项目',
};

function BoardFilterButton({
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

function LaneIdentity({
  grouping,
  works,
  label,
  humans,
  participants,
  humanNames,
}: {
  readonly grouping: ProjectBoardGrouping;
  readonly works: readonly CollectiveWorkProjection[];
  readonly label: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
}) {
  const work = works[0];
  if (grouping === 'executor' && work?.assignment) {
    return <AgentIdentityChip assignment={work.assignment} participants={participants} />;
  }
  if (grouping !== 'project' && work?.accountableHumanId) {
    return (
      <HumanIdentityChip
        humanId={work.accountableHumanId}
        humans={humans}
        fallbackName={humanNames[work.accountableHumanId] ?? label}
      />
    );
  }
  return <strong>{label}</strong>;
}

function projectRecordsForWorks(
  roadmaps: readonly CollectiveRoadmapRecord[],
): ReadonlyMap<string, readonly CollectiveRoadmapRecord[]> {
  const result = new Map<string, CollectiveRoadmapRecord[]>();
  for (const roadmap of roadmaps) {
    for (const workId of roadmap.workIds) result.set(workId, [...(result.get(workId) ?? []), roadmap]);
  }
  return result;
}
