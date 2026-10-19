import type { CollectiveWorkProjection } from './client-types.js';
import { roadmapStatusTone } from './roadmap-view-model.js';
import { workExecutionPresentation } from './work-execution-presentation.js';

export function RoadmapWorkNode({
  work,
  humanNames,
  selected,
  responsibility,
  onSelect,
}: {
  readonly work: CollectiveWorkProjection;
  readonly humanNames: Readonly<Record<string, string>>;
  readonly selected: boolean;
  readonly responsibility?: string;
  readonly onSelect: (workId: string) => void;
}) {
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? '共同体成员') : '未分配';
  const execution = workExecutionPresentation(work);
  const ownership = work.assignment
    ? `${work.assignment.displayName} ${execution.assignmentAction} · ${accountable} 负责`
    : work.accountableHumanId
      ? `${accountable} 负责`
      : '未分配 · 等待负责人接下';
  return (
    <button
      type="button"
      className="roadmap-work-node"
      data-roadmap-work-id={work.workId}
      data-status-tone={roadmapStatusTone(work.status)}
      data-work-status={work.status}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(work.workId)}
    >
      <span className="roadmap-work-node-status">{execution.statusLabel}</span>
      <strong>{work.title}</strong>
      <small>{responsibility ?? ownership}</small>
    </button>
  );
}
