import { workExecutionPresentation } from './CollectiveWorkCard.js';
import type { CollectiveWorkProjection } from './client-types.js';
import { actorName, formatHistoryTime, type RoadmapViewState, workHistoryLabels } from './roadmap-view-model.js';

export function RoadmapWorkDetails({
  work,
  works,
  view,
  currentHumanId,
  humanNames,
  canEditDependencies,
  onSetDependencies,
  onOpenSource,
  onOpenResult,
  onClose,
}: {
  readonly work: CollectiveWorkProjection;
  readonly works: readonly CollectiveWorkProjection[];
  readonly view: RoadmapViewState;
  readonly currentHumanId: string;
  readonly humanNames: Readonly<Record<string, string>>;
  readonly canEditDependencies: boolean;
  readonly onSetDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) => void;
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenResult?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onClose: () => void;
}) {
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? 'Collective 成员') : '待确认';
  const dependencies = work.dependencyWorkIds
    .map((workId) => works.find((candidate) => candidate.workId === workId))
    .filter((candidate): candidate is CollectiveWorkProjection => Boolean(candidate));
  const sourceKind = work.sourceLocation.rootEventId ? '话题' : '频道消息';
  const canEdit = canEditDependencies && work.accountableHumanId === currentHumanId;
  const execution = workExecutionPresentation(work);
  return (
    <aside className="roadmap-work-details" aria-label={`工作详情 · ${work.title}`}>
      <header>
        <div>
          <span>{execution.statusLabel}</span>
          <h3>{work.title}</h3>
        </div>
        <button type="button" className="roadmap-details-close" aria-label="关闭工作详情" onClick={onClose}>
          ×
        </button>
      </header>
      <p>{work.intendedOutcome}</p>
      {execution.admissionMessage && <p className="work-admission">{execution.admissionMessage}</p>}
      <dl>
        <div>
          <dt>现实责任</dt>
          <dd>{accountable} 负责</dd>
        </div>
        <div>
          <dt>猫的参与</dt>
          <dd>{work.assignment ? `${work.assignment.displayName} ${execution.assignmentAction}` : '尚未交给猫'}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>
            #{work.sourceLocation.channelId} · {sourceKind}
          </dd>
        </div>
        <div>
          <dt>前置工作</dt>
          <dd>{dependencies.length ? dependencies.map((item) => item.title).join('、') : '没有前置工作'}</dd>
        </div>
      </dl>
      <div className="roadmap-details-actions">
        {onOpenSource && (
          <button type="button" onClick={() => onOpenSource(work, view)}>
            查看来源消息
          </button>
        )}
        {work.resultEventId && onOpenResult && (
          <button type="button" onClick={() => onOpenResult(work, view)}>
            查看结果消息
          </button>
        )}
      </div>
      {canEdit && (
        <details className="roadmap-dependency-editor">
          <summary>调整前置工作</summary>
          {works
            .filter((candidate) => candidate.workId !== work.workId)
            .map((candidate) => {
              const selected = work.dependencyWorkIds.includes(candidate.workId);
              return (
                <button
                  key={candidate.workId}
                  type="button"
                  onClick={() =>
                    onSetDependencies(
                      work,
                      selected
                        ? work.dependencyWorkIds.filter((workId) => workId !== candidate.workId)
                        : [...work.dependencyWorkIds, candidate.workId],
                    )
                  }
                >
                  {selected ? '不再等待' : '等待'} {candidate.title}
                </button>
              );
            })}
        </details>
      )}
      <section className="roadmap-work-history" aria-label="工作历史">
        <h4>工作历史</h4>
        <ol>
          {[...work.history].reverse().map((entry) => (
            <li key={`${entry.revision}:${entry.action}`}>
              <strong>
                {workHistoryLabels[entry.action]}
                {isResultHistoryAction(entry.action) ? ` · 结果 v${entry.resultRevision ?? 1}` : ''}
              </strong>
              <span>
                {actorName(entry.actor)} · {formatHistoryTime(entry.at)}
              </span>
              {entry.note && <p>{entry.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}

function isResultHistoryAction(action: CollectiveWorkProjection['history'][number]['action']): boolean {
  return action === 'result_returned' || action === 'revision_requested' || action === 'result_accepted';
}
