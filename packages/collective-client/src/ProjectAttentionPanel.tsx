import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CollectiveMemberDirectory, CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { ProjectMaterialAttentionRow } from './ProjectMaterialAttentionRow.js';
import { workAccountabilityRequestState } from './roadmap-view-model.js';

type ProjectAttentionKind = 'accountability_request' | 'unassigned' | 'result_ready' | 'date_suggestion' | 'overdue';

interface ProjectAttentionItem {
  readonly key: string;
  readonly kind: ProjectAttentionKind;
  readonly targetHumanId: string;
  readonly roadmap: CollectiveRoadmapRecord;
  readonly work: CollectiveWorkProjection;
  readonly sinceAt: string;
}

export function ProjectAttentionPanel({
  roadmaps,
  works,
  humans,
  humanNames,
  currentHumanId,
  hidden = false,
  onOpen,
  onOpenMaterials,
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly currentHumanId: string;
  readonly hidden?: boolean;
  readonly onOpenMaterials?: (roadmap: CollectiveRoadmapRecord) => void;
  readonly onOpen: (roadmap: CollectiveRoadmapRecord, work: CollectiveWorkProjection) => void;
}) {
  const en = useCollectiveLanguage() === 'en';
  const [materialCounts, setMaterialCounts] = useState<Record<string, number>>({});
  const onMaterialCount = useCallback(
    (id: string, count: number) =>
      setMaterialCounts((current) => (current[id] === count ? current : { ...current, [id]: count })),
    [],
  );
  const [selectedHumanId, setSelectedHumanId] = useState(currentHumanId);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setSelectedHumanId(currentHumanId);
    setShowAll(false);
  }, [currentHumanId]);
  const items = useMemo(() => projectAttentionItems(roadmaps, works), [roadmaps, works]);
  const materialProjects = roadmaps.filter(
    (project) => project.status === 'active' && (showAll || project.accountableHumanId === selectedHumanId),
  );
  const materialCount = onOpenMaterials
    ? materialProjects.filter((project) => (materialCounts[project.roadmapId] ?? 0) > 0).length
    : 0;
  const selected = showAll ? items : items.filter((item) => item.targetHumanId === selectedHumanId);
  const people = humans.some((human) => human.humanId === currentHumanId)
    ? humans
    : [
        {
          kind: 'human' as const,
          humanId: currentHumanId,
          displayName: humanNames[currentHumanId] ?? '我',
          role: 'member' as const,
        },
        ...humans,
      ];
  return (
    <section className="project-attention" aria-label="项目待办" hidden={hidden}>
      <header>
        <div>
          <strong>待办</strong>
          <span>
            {selected.length + materialCount} {en ? 'items' : '件'}
          </span>
        </div>
        <div className="project-attention-controls">
          <button
            type="button"
            className="project-attention-all"
            aria-label="全部待办"
            aria-pressed={showAll}
            onClick={() => setShowAll((current) => !current)}
          >
            全部待办
          </button>
          <label>
            看谁的：
            <select
              aria-label="待办成员"
              value={selectedHumanId}
              onChange={(event) => {
                setSelectedHumanId(event.currentTarget.value);
                setShowAll(false);
              }}
            >
              {people.map((human) => (
                <option key={human.humanId} value={human.humanId}>
                  {human.humanId === currentHumanId ? '我' : human.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {selected.length || onOpenMaterials ? (
        <ul>
          {!selected.length && !materialCount && (
            <li className="project-attention-empty">当前没有需要这位成员处理的项目事项。</li>
          )}
          {onOpenMaterials &&
            materialProjects.map((project) => (
              <ProjectMaterialAttentionRow
                key={project.roadmapId}
                project={project}
                onOpen={onOpenMaterials}
                onCount={onMaterialCount}
              />
            ))}
          {selected.map((item) => (
            <li key={item.key}>
              <span className={`project-attention-status is-${item.kind}`}>{attentionStatus(item, en)}</span>
              <div>
                <strong>{item.work.title}</strong>
                <span>
                  {item.roadmap.title}
                  {waitingDays(item.sinceAt)}
                </span>
              </div>
              <button type="button" onClick={() => onOpen(item.roadmap, item.work)}>
                {attentionAction(item, currentHumanId, en)}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>当前没有需要这位成员处理的项目事项。</p>
      )}
    </section>
  );
}

function projectAttentionItems(
  roadmaps: readonly CollectiveRoadmapRecord[],
  works: readonly CollectiveWorkProjection[],
): ProjectAttentionItem[] {
  const active = roadmaps.filter((roadmap) => roadmap.status === 'active');
  const items = new Map<string, ProjectAttentionItem>();
  for (const work of works) {
    const containing = active.filter((roadmap) => roadmap.workIds.includes(work.workId));
    if (!containing.length) continue;
    for (const item of attentionItemsForWork(work, containing)) if (!items.has(item.key)) items.set(item.key, item);
  }
  for (const work of works) {
    const project = active.find((project) => project.workIds.includes(work.workId));
    if (
      !project ||
      !work.accountableHumanId ||
      ['proposed', 'completed', 'cancelled', 'declined'].includes(work.lifecycle)
    )
      continue;
    if (work.timeSuggestions?.some((item) => item.status === 'pending'))
      items.set(`date:${work.workId}`, {
        key: `date:${work.workId}`,
        kind: 'date_suggestion',
        targetHumanId: work.accountableHumanId,
        roadmap: project,
        work,
        sinceAt: work.timeSuggestions.find((item) => item.status === 'pending')!.at,
      });
    if (work.time?.businessDeadline && Date.parse(work.time.businessDeadline.value) < Date.now())
      items.set(`overdue:${work.workId}`, {
        key: `overdue:${work.workId}`,
        kind: 'overdue',
        targetHumanId: work.accountableHumanId,
        roadmap: project,
        work,
        sinceAt: work.time.businessDeadline.value,
      });
  }
  return [...items.values()].sort(
    (left, right) => left.sinceAt.localeCompare(right.sinceAt) || left.work.title.localeCompare(right.work.title),
  );
}

function attentionItemsForWork(
  work: CollectiveWorkProjection,
  containing: readonly CollectiveRoadmapRecord[],
): ProjectAttentionItem[] {
  const requestState = workAccountabilityRequestState(work, containing);
  if (requestState.pending) {
    if (!requestState.roadmap) return [];
    const request = requestState.pending;
    return [
      {
        key: `request:${request.accountabilityRequestId}`,
        kind: 'accountability_request',
        targetHumanId: request.targetHumanId,
        roadmap: requestState.roadmap,
        work,
        sinceAt: request.requestedAt,
      },
    ];
  }
  const resultItem = resultAttentionItem(work, containing[0]);
  if (resultItem) return [resultItem];
  if (work.lifecycle !== 'committed' || work.accountableHumanId || work.assignment) return [];
  const committed = work.history.find((entry) => entry.action === 'committed');
  return containing.map((roadmap) => ({
    key: `unassigned:${work.workId}:${roadmap.accountableHumanId}`,
    kind: 'unassigned',
    targetHumanId: roadmap.accountableHumanId,
    roadmap,
    work,
    sinceAt: committed?.at ?? work.createdAt,
  }));
}

function resultAttentionItem(
  work: CollectiveWorkProjection,
  roadmap: CollectiveRoadmapRecord | undefined,
): ProjectAttentionItem | undefined {
  if (work.lifecycle !== 'result_ready' || !work.accountableHumanId || !roadmap) return undefined;
  const returned = [...work.history].reverse().find((entry) => entry.action === 'result_returned');
  const key = `result:${work.workId}:${work.accountableHumanId}`;
  return {
    key,
    kind: 'result_ready',
    targetHumanId: work.accountableHumanId,
    roadmap,
    work,
    sinceAt: returned?.at ?? work.updatedAt,
  };
}

function attentionStatus(item: ProjectAttentionItem, en = false) {
  if (item.kind === 'date_suggestion') return en ? 'Date suggestion' : '日期建议';
  if (item.kind === 'overdue') return en ? 'Past deadline' : '超过截止';
  if (item.kind === 'accountability_request') return '责任邀请';
  if (item.kind === 'result_ready') return '待验收';
  return '待指派';
}

function attentionAction(item: ProjectAttentionItem, currentHumanId: string, en = false) {
  if (item.kind === 'overdue') return en ? 'Change date / View' : '改日期… / 去看看';
  if (item.kind === 'date_suggestion') return en ? 'Review suggestions' : '确认日期建议';
  if (item.targetHumanId !== currentHumanId) return '查看任务';
  if (item.kind === 'accountability_request') return '处理邀请';
  if (item.kind === 'result_ready') return '验收结果';
  return '指定负责人…';
}

function waitingDays(sinceAt: string) {
  const elapsed = Date.now() - Date.parse(sinceAt);
  const days = Number.isFinite(elapsed) ? Math.floor(elapsed / 86_400_000) : 0;
  return days > 0 ? ` · ${days} 天没回` : '';
}
