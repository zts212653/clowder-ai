import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import {
  actorName,
  canEditWorkDependencies,
  canTrackWorkInProject,
  formatHistoryTime,
  type RoadmapViewState,
  workHistoryLabels,
} from './roadmap-view-model.js';
import { WorkAccountabilityActions } from './WorkAccountabilityActions.js';
import { resolveWorkDependencies, unreadableDependencyLabel } from './work-dependency-resolution.js';
import { workExecutionPresentation } from './work-execution-presentation.js';

export function RoadmapWorkDetails({
  work,
  roadmap,
  allRoadmaps = roadmap ? [roadmap] : [],
  availableWorks,
  view,
  currentHumanId,
  humanNames,
  humans = [],
  participants = [],
  canEditDependencies,
  onSetDependencies,
  onCommitWork,
  onRequestWorkAccountability,
  onRespondWorkAccountability,
  onOpenSource,
  onOpenResult,
  onClose,
}: {
  readonly work: CollectiveWorkProjection;
  readonly roadmap?: CollectiveRoadmapRecord;
  readonly allRoadmaps?: readonly CollectiveRoadmapRecord[];
  readonly availableWorks: readonly CollectiveWorkProjection[];
  readonly view: RoadmapViewState;
  readonly currentHumanId: string;
  readonly humanNames: Readonly<Record<string, string>>;
  readonly humans?: CollectiveMemberDirectory['humans'];
  readonly participants?: readonly CollectiveParticipant[];
  readonly canEditDependencies: boolean;
  readonly onSetDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) => void;
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
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenResult?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onClose: () => void;
}) {
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? '共同体成员') : '未分配';
  const dependencies = resolveWorkDependencies(work, availableWorks);
  const dependencyLabels = dependencies.resolved.map(
    (dependency) => `${dependency.title}（#${dependency.sourceLocation.channelId}）`,
  );
  if (dependencies.unresolvedCount) {
    dependencyLabels.push(unreadableDependencyLabel(dependencies.unresolvedCount));
  }
  const sourceKind = work.sourceLocation.rootEventId ? '话题' : '频道消息';
  const canEdit = canEditDependencies && canEditWorkDependencies(work) && work.accountableHumanId === currentHumanId;
  const execution = workExecutionPresentation(work);
  return (
    <aside className="roadmap-work-details" aria-label={`任务详情 · ${work.title}`}>
      <header>
        <div>
          <span>{execution.statusLabel}</span>
          <h3>{work.title}</h3>
        </div>
        <button type="button" className="roadmap-details-close" aria-label="关闭任务详情" onClick={onClose}>
          ×
        </button>
      </header>
      <p>{work.intendedOutcome}</p>
      {execution.admissionMessage && <p className="work-admission">{execution.admissionMessage}</p>}
      <dl>
        <div>
          <dt>负责人</dt>
          <dd>{work.accountableHumanId ? `${accountable} 负责` : '未分配'}</dd>
        </div>
        <div>
          <dt>执行</dt>
          <dd>{work.assignment ? `${work.assignment.displayName} ${execution.assignmentAction}` : accountable}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>
            #{work.sourceLocation.channelId} · {sourceKind}
          </dd>
        </div>
        <div>
          <dt>前置任务</dt>
          <dd>{dependencyLabels.length ? dependencyLabels.join('、') : '没有前置任务'}</dd>
        </div>
      </dl>
      {roadmap && (
        <WorkAccountabilityActions
          roadmap={roadmap}
          roadmaps={allRoadmaps}
          work={work}
          currentHumanId={currentHumanId}
          humans={humans}
          participants={participants}
          onCommit={onCommitWork}
          onRequest={onRequestWorkAccountability}
          onRespond={onRespondWorkAccountability}
        />
      )}
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
          <summary>调整前置任务</summary>
          {availableWorks
            .filter((candidate) => candidate.workId !== work.workId && canTrackWorkInProject(candidate))
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
      <section className="roadmap-work-history" aria-label="任务动态">
        <h4>动态</h4>
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
