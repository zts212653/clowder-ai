import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';

export type RoadmapLens = 'stage' | 'dependencies' | 'mine' | 'artifacts' | 'triage';
export type RoadmapPresentation = 'graph' | 'board';
export type RoadmapScope = 'focus' | 'all' | 'unfinished';
export type RoadmapRelation = 'all' | 'mine';
export type ProjectWorkspaceView = 'project' | 'list' | 'dependencies' | 'board';
export type ProjectBoardColumn = 'queued' | 'in_progress' | 'result_ready' | 'completed';
export type ProjectBoardGrouping = 'executor' | 'accountable' | 'project';

export interface RoadmapViewState {
  readonly roadmapId?: string;
  readonly lens: RoadmapLens;
  readonly presentation: RoadmapPresentation;
  readonly scope: RoadmapScope;
  readonly relation?: RoadmapRelation;
  readonly workspace?: ProjectWorkspaceView;
  readonly workId?: string;
}

export const defaultRoadmapView: RoadmapViewState = {
  lens: 'stage',
  presentation: 'graph',
  scope: 'all',
  relation: 'all',
  workspace: 'list',
};

const activeStatuses = new Set<CollectiveWorkProjection['status']>(['blocked', 'in_progress', 'result_ready']);
const settledStatuses = new Set<CollectiveWorkProjection['status']>(['completed', 'declined', 'cancelled']);
const terminalLifecycles = new Set<CollectiveWorkProjection['lifecycle']>(['completed', 'declined', 'cancelled']);
const untrackableProjectLifecycles = new Set<CollectiveWorkProjection['lifecycle']>([
  'proposed',
  'declined',
  'cancelled',
]);

export function canEditWorkDependencies(work: CollectiveWorkProjection): boolean {
  return !terminalLifecycles.has(work.lifecycle);
}

export function canChangeWorkResponsibility(roadmap: CollectiveRoadmapRecord, work: CollectiveWorkProjection): boolean {
  return (
    roadmap.status === 'active' &&
    roadmap.workIds.includes(work.workId) &&
    work.lifecycle === 'committed' &&
    !work.assignment
  );
}

type AccountabilityRequest = NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number];

export interface WorkAccountabilityRequestState {
  readonly pending?: AccountabilityRequest;
  readonly roadmap?: CollectiveRoadmapRecord;
}

/** Resolve a pending invitation through the Project that issued it, never the Project currently rendering the Work. */
export function workAccountabilityRequestState(
  work: CollectiveWorkProjection,
  roadmaps: readonly CollectiveRoadmapRecord[],
): WorkAccountabilityRequestState {
  const pending = work.accountabilityRequests?.find((request) => request.status === 'pending');
  if (!pending) return {};
  const roadmap = roadmaps.find((candidate) => candidate.roadmapId === pending.roadmapId);
  return roadmap && canChangeWorkResponsibility(roadmap, work) ? { pending, roadmap } : { pending };
}

export function canTrackWorkInProject(work: CollectiveWorkProjection): boolean {
  return !untrackableProjectLifecycles.has(work.lifecycle);
}

export function canCompleteProject(
  roadmap: CollectiveRoadmapRecord,
  works: readonly CollectiveWorkProjection[],
): boolean {
  return works.length === roadmap.workIds.length && works.every((work) => work.lifecycle === 'completed');
}

export function worksForRoadmap(
  roadmap: CollectiveRoadmapRecord,
  works: readonly CollectiveWorkProjection[],
): readonly CollectiveWorkProjection[] {
  const byId = new Map(works.map((work) => [work.workId, work]));
  return roadmap.workIds.map((workId) => byId.get(workId)).filter((work) => work !== undefined);
}

export function worksForProjects(
  roadmaps: readonly CollectiveRoadmapRecord[],
  works: readonly CollectiveWorkProjection[],
): readonly CollectiveWorkProjection[] {
  const projectWorkIds = new Set(roadmaps.flatMap((roadmap) => roadmap.workIds));
  return works.filter((work) => projectWorkIds.has(work.workId) && canTrackWorkInProject(work));
}

export function projectBoardColumn(work: CollectiveWorkProjection): ProjectBoardColumn {
  switch (work.lifecycle) {
    case 'completed':
      return 'completed';
    case 'result_ready':
      return 'result_ready';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'queued';
  }
}

export interface ProjectExecutorLane {
  readonly id: string;
  readonly label: string;
  readonly accountableLabel?: string;
  readonly unassigned: boolean;
  readonly works: readonly CollectiveWorkProjection[];
}

export type ProjectBoardLane = ProjectExecutorLane;

export function projectExecutorLanes(
  works: readonly CollectiveWorkProjection[],
  humanNames: Readonly<Record<string, string>>,
): readonly ProjectExecutorLane[] {
  const lanes = new Map<string, Omit<ProjectExecutorLane, 'works'> & { works: CollectiveWorkProjection[] }>();
  for (const work of works) {
    const descriptor = executorDescriptor(work, humanNames);
    const lane = lanes.get(descriptor.id) ?? { ...descriptor, works: [] };
    lane.works.push(work);
    lanes.set(descriptor.id, lane);
  }
  return [...lanes.values()].sort((left, right) => {
    if (left.unassigned !== right.unassigned) return left.unassigned ? -1 : 1;
    return left.label.localeCompare(right.label, 'zh-CN');
  });
}

export function projectBoardLanes(
  grouping: ProjectBoardGrouping,
  roadmaps: readonly CollectiveRoadmapRecord[],
  works: readonly CollectiveWorkProjection[],
  humanNames: Readonly<Record<string, string>>,
): readonly ProjectBoardLane[] {
  if (grouping === 'executor') return projectExecutorLanes(works, humanNames);
  const projectsByWork = new Map<string, CollectiveRoadmapRecord[]>();
  for (const roadmap of roadmaps) {
    for (const workId of roadmap.workIds) {
      const projects = projectsByWork.get(workId) ?? [];
      projects.push(roadmap);
      projectsByWork.set(workId, projects);
    }
  }
  const lanes = new Map<string, Omit<ProjectBoardLane, 'works'> & { works: CollectiveWorkProjection[] }>();
  for (const work of works) {
    const descriptor =
      grouping === 'accountable'
        ? accountableDescriptor(work, humanNames)
        : projectDescriptor(projectsByWork.get(work.workId) ?? []);
    const lane = lanes.get(descriptor.id) ?? { ...descriptor, works: [] };
    lane.works.push(work);
    lanes.set(descriptor.id, lane);
  }
  return [...lanes.values()].sort((left, right) => Number(right.unassigned) - Number(left.unassigned));
}

function accountableDescriptor(
  work: CollectiveWorkProjection,
  humanNames: Readonly<Record<string, string>>,
): Omit<ProjectBoardLane, 'works'> {
  if (!work.accountableHumanId) return { id: 'unassigned', label: '未分配', unassigned: true };
  return {
    id: `accountable:${work.accountableHumanId}`,
    label: humanNames[work.accountableHumanId] ?? '共同体成员',
    unassigned: false,
  };
}

function projectDescriptor(projects: readonly CollectiveRoadmapRecord[]): Omit<ProjectBoardLane, 'works'> {
  if (projects.length === 1 && projects[0]) {
    return { id: `project:${projects[0].roadmapId}`, label: projects[0].title, unassigned: false };
  }
  if (projects.length > 1) {
    return {
      id: `projects:${projects
        .map((project) => project.roadmapId)
        .sort()
        .join(':')}`,
      label: '关联多个项目',
      accountableLabel: projects.map((project) => project.title).join('、'),
      unassigned: false,
    };
  }
  return { id: 'project:unknown', label: '未归入项目', unassigned: false };
}

function executorDescriptor(
  work: CollectiveWorkProjection,
  humanNames: Readonly<Record<string, string>>,
): Omit<ProjectExecutorLane, 'works'> {
  if (work.assignment) {
    return {
      id: `agent:${work.assignment.connectionId}:${work.assignment.catId}`,
      label: work.assignment.displayName,
      accountableLabel: humanNames[work.assignment.humanId] ?? '共同体成员',
      unassigned: false,
    };
  }
  if (work.accountableHumanId) {
    return {
      id: `human:${work.accountableHumanId}`,
      label: humanNames[work.accountableHumanId] ?? '共同体成员',
      unassigned: false,
    };
  }
  return { id: 'unassigned', label: '未分配', unassigned: true };
}

export function visibleRoadmapWorks(
  works: readonly CollectiveWorkProjection[],
  view: RoadmapViewState,
  currentHumanId: string,
): readonly CollectiveWorkProjection[] {
  const lensWorks =
    view.lens === 'mine' || view.relation === 'mine'
      ? works.filter((work) => {
          if (work.accountableHumanId === currentHumanId) return true;
          return work.assignment?.humanId === currentHumanId;
        })
      : works;
  if (view.scope === 'all') return lensWorks;
  if (view.lens === 'artifacts') return lensWorks;
  if (view.scope === 'unfinished') return lensWorks.filter((work) => !terminalLifecycles.has(work.lifecycle));
  const focusIds = new Set(focusWorkIds(lensWorks));
  if (view.workId && lensWorks.some((work) => work.workId === view.workId)) focusIds.add(view.workId);
  return lensWorks.filter((work) => focusIds.has(work.workId));
}

function focusWorkIds(works: readonly CollectiveWorkProjection[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const work of works) {
    if (activeStatuses.has(work.status)) ids.add(work.workId);
    if (work.status === 'blocked') {
      for (const dependencyId of work.dependencyWorkIds) ids.add(dependencyId);
    }
  }
  if (ids.size === 0) {
    const next = works.find((work) => !['completed', 'declined', 'cancelled'].includes(work.status));
    if (next) ids.add(next.workId);
  }
  const last = works.at(-1);
  if (ids.size === 0 && last) ids.add(last.workId);
  return ids;
}

export function dependencyLevels(works: readonly CollectiveWorkProjection[]): ReadonlyMap<string, number> {
  const byId = new Map(works.map((work) => [work.workId, work]));
  const resolved = new Map<string, number>();
  const visit = (workId: string, stack: ReadonlySet<string>): number => {
    const cached = resolved.get(workId);
    if (cached !== undefined) return cached;
    const work = byId.get(workId);
    if (!work) return 0;
    if (stack.has(workId)) return 0;
    const nextStack = new Set(stack).add(workId);
    const dependencies = work.dependencyWorkIds.filter((dependencyId) => byId.has(dependencyId));
    const level = dependencies.length
      ? Math.max(...dependencies.map((dependencyId) => visit(dependencyId, nextStack))) + 1
      : 0;
    resolved.set(workId, level);
    return level;
  };
  for (const work of works) visit(work.workId, new Set());
  return resolved;
}

export type RoadmapStatusTone = 'accepted' | 'active' | 'blocked' | 'queued';

export function roadmapStatusTone(status: CollectiveWorkProjection['status']): RoadmapStatusTone {
  if (status === 'completed') return 'accepted';
  if (status === 'blocked') return 'blocked';
  if (activeStatuses.has(status)) return 'active';
  return 'queued';
}

export function stageForWork(status: CollectiveWorkProjection['status']): 'queued' | 'active' | 'accepted' {
  if (settledStatuses.has(status)) return 'accepted';
  if (activeStatuses.has(status)) return 'active';
  return 'queued';
}

export const stageLabels = {
  queued: '待开始',
  active: '进行中',
  accepted: '已完成',
} as const;

export const roadmapHistoryLabels: Record<CollectiveRoadmapRecord['history'][number]['action'], string> = {
  target_date_changed: '修改了项目目标日期',
  created: '新建了项目',
  works_changed: '调整了项目任务',
  completed: '完成了项目',
  reopened: '重新打开了项目',
};

export const workHistoryLabels: Record<CollectiveWorkProjection['history'][number]['action'], string> = {
  material_linked: '材料已关联',
  time_changed: '修改了日期',
  time_suggested: '建议修改日期',
  time_suggestion_resolved: '处理了日期建议',
  proposed: '建议了任务',
  committed: '接纳了任务',
  accountability_assigned: '接下了任务',
  accountability_requested: '邀请了负责人',
  accountability_request_accepted: '接受了负责人邀请',
  accountability_request_declined: '暂未接受负责人邀请',
  dependencies_changed: '调整了前置任务',
  progress_started: '开始执行',
  progress_reported: '更新了进度',
  result_returned: '把结果带回原讨论',
  revision_requested: '退回结果并提出修订',
  execution_authorized: '继续执行',
  result_accepted: '确认了结果',
  completed: '完成了任务',
  declined: '决定不再跟踪',
  cancelled: '取消了任务',
};

export function actorName(actor: CollectiveWorkProjection['history'][number]['actor']): string {
  return actor.displayName;
}

export function formatHistoryTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
