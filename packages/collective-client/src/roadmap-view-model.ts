import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';

export type RoadmapLens = 'stage' | 'dependencies' | 'mine';
export type RoadmapPresentation = 'graph' | 'board';
export type RoadmapScope = 'focus' | 'all';

export interface RoadmapViewState {
  readonly roadmapId?: string;
  readonly lens: RoadmapLens;
  readonly presentation: RoadmapPresentation;
  readonly scope: RoadmapScope;
  readonly workId?: string;
}

export const defaultRoadmapView: RoadmapViewState = {
  lens: 'stage',
  presentation: 'graph',
  scope: 'focus',
};

const activeStatuses = new Set<CollectiveWorkProjection['status']>(['blocked', 'in_progress', 'result_ready']);
const settledStatuses = new Set<CollectiveWorkProjection['status']>(['completed', 'declined', 'cancelled']);

export function worksForRoadmap(
  roadmap: CollectiveRoadmapRecord,
  works: readonly CollectiveWorkProjection[],
): readonly CollectiveWorkProjection[] {
  const byId = new Map(works.map((work) => [work.workId, work]));
  return roadmap.workIds.map((workId) => byId.get(workId)).filter((work) => work !== undefined);
}

export function visibleRoadmapWorks(
  works: readonly CollectiveWorkProjection[],
  view: RoadmapViewState,
  currentHumanId: string,
): readonly CollectiveWorkProjection[] {
  const lensWorks =
    view.lens === 'mine'
      ? works.filter((work) => {
          if (work.accountableHumanId === currentHumanId) return true;
          return work.assignment?.humanId === currentHumanId;
        })
      : works;
  if (view.scope === 'all') return lensWorks;
  if (view.lens !== 'stage') return lensWorks;
  const focusIds = focusWorkIds(lensWorks);
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
  queued: '待启动',
  active: '推进中',
  accepted: '已完成',
} as const;

export const roadmapHistoryLabels: Record<CollectiveRoadmapRecord['history'][number]['action'], string> = {
  created: '建立了路线',
  works_changed: '调整了路线工作',
  completed: '完成了路线',
  reopened: '重新打开了路线',
};

export const workHistoryLabels: Record<CollectiveWorkProjection['history'][number]['action'], string> = {
  proposed: '提出了工作',
  committed: '确认了工作',
  dependencies_changed: '调整了前置工作',
  progress_started: '开始推进',
  progress_reported: '进度回报',
  result_returned: '把结果带回原讨论',
  revision_requested: '退回结果并提出修订',
  execution_authorized: '继续执行',
  result_accepted: '确认了结果',
  completed: '完成了工作',
  declined: '决定不再跟踪',
  cancelled: '取消了工作',
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
