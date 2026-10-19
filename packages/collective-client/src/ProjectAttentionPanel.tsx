import { useEffect, useMemo, useState } from 'react';
import type { CollectiveMemberDirectory, CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { workAccountabilityRequestState } from './roadmap-view-model.js';

type ProjectAttentionKind = 'accountability_request' | 'unassigned' | 'result_ready';

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
}: {
  readonly roadmaps: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly currentHumanId: string;
  readonly hidden?: boolean;
  readonly onOpen: (roadmap: CollectiveRoadmapRecord, work: CollectiveWorkProjection) => void;
}) {
  const [selectedHumanId, setSelectedHumanId] = useState(currentHumanId);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setSelectedHumanId(currentHumanId);
    setShowAll(false);
  }, [currentHumanId]);
  const items = useMemo(() => projectAttentionItems(roadmaps, works), [roadmaps, works]);
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
          <span>{selected.length} 件</span>
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
      {selected.length ? (
        <ul>
          {selected.map((item) => (
            <li key={item.key}>
              <span className={`project-attention-status is-${item.kind}`}>{attentionStatus(item)}</span>
              <div>
                <strong>{item.work.title}</strong>
                <span>
                  {item.roadmap.title}
                  {waitingDays(item.sinceAt)}
                </span>
              </div>
              <button type="button" onClick={() => onOpen(item.roadmap, item.work)}>
                {attentionAction(item, currentHumanId)}
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

function attentionStatus(item: ProjectAttentionItem) {
  if (item.kind === 'accountability_request') return '责任邀请';
  if (item.kind === 'result_ready') return '待验收';
  return '待指派';
}

function attentionAction(item: ProjectAttentionItem, currentHumanId: string) {
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
