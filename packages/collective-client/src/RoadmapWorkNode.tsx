import { workExecutionPresentation } from './CollectiveWorkCard.js';
import type { CollectiveWorkProjection } from './client-types.js';
import { roadmapStatusTone } from './roadmap-view-model.js';

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
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? 'Collective 成员') : '待确认';
  const execution = workExecutionPresentation(work);
  const ownership = work.assignment
    ? `${work.assignment.displayName} ${execution.assignmentAction} · ${accountable} 负责`
    : `${accountable} 负责`;
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
