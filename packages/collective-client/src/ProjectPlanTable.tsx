import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import { WorkIdentityChips } from './ProjectIdentityChip.js';
import { ProjectResponsibilityInline } from './ProjectResponsibilityInline.js';
import { dependencyLevels, formatHistoryTime, workHistoryLabels } from './roadmap-view-model.js';
import { WorkTimeSummary } from './WorkTimeSummary.js';
import { workBlockingPresentation, workDependencyPresentation } from './work-blocking-presentation.js';
import { workExecutionPresentation } from './work-execution-presentation.js';

interface ProjectPlanProps {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly allRoadmaps?: readonly CollectiveRoadmapRecord[];
  readonly works: readonly CollectiveWorkProjection[];
  readonly availableWorks: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly selectedWorkId?: string;
  readonly onSelect: (workId: string) => void;
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
}

export function ProjectPlanTable(props: ProjectPlanProps) {
  const levels = dependencyLevels(props.works);
  const ordered = [...props.works].sort(
    (left, right) =>
      (levels.get(left.workId) ?? 0) - (levels.get(right.workId) ?? 0) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.title.localeCompare(right.title, 'zh-CN'),
  );
  const completed = ordered.filter((work) => work.lifecycle === 'completed');
  const current = ordered.filter((work) => work.lifecycle !== 'completed');
  return (
    <section className="project-plan" aria-label="项目任务计划">
      <header className="project-plan-columns">
        <span>任务</span>
        <span>执行</span>
        <span>阻塞 / 前置</span>
        <span>下一次交付</span>
        <span>时间</span>
      </header>
      {completed.length > 0 && (
        <details className="project-plan-completed" aria-label="已完成任务">
          <summary>
            <span>已完成 {completed.length} 项</span>
            <small>{completed.map((work) => work.title).join(' · ')}</small>
          </summary>
          {completed.map((work) => (
            <ProjectPlanRow key={work.workId} {...props} work={work} />
          ))}
        </details>
      )}
      <div className="project-plan-current">
        {current.length ? (
          current.map((work) => <ProjectPlanRow key={work.workId} {...props} work={work} />)
        ) : (
          <p className="project-plan-empty">没有未完成任务。</p>
        )}
      </div>
    </section>
  );
}

function ProjectPlanRow({ work, ...props }: ProjectPlanProps & { readonly work: CollectiveWorkProjection }) {
  const recent = work.history.at(-1);
  const execution = workExecutionPresentation(work);
  return (
    <article
      className="project-plan-row"
      data-project-plan-work-id={work.workId}
      data-blocked={work.status === 'blocked' || undefined}
      data-selected={props.selectedWorkId === work.workId || undefined}
    >
      <button type="button" className="project-plan-task" onClick={() => props.onSelect(work.workId)}>
        <span className="project-plan-status" data-work-status-label={work.status}>
          {execution.statusLabel}
        </span>
        <strong>{work.title}</strong>
      </button>
      <div className="project-plan-execution">
        <WorkIdentityChips
          work={work}
          humans={props.humans}
          participants={props.participants}
          humanNames={props.humanNames}
        />
        <ProjectResponsibilityInline
          roadmap={props.roadmap}
          roadmaps={props.allRoadmaps ?? [props.roadmap]}
          work={work}
          currentHumanId={props.currentHumanId}
          humans={props.humans}
          onCommit={props.onCommitWork}
          onRequest={props.onRequestWorkAccountability}
          onRespond={props.onRespondWorkAccountability}
        />
      </div>
      <div className="project-plan-dependencies">
        <ProjectDependencySummary work={work} availableWorks={props.availableWorks} />
      </div>
      <p className="project-plan-delivery">{work.intendedOutcome || '未填写'}</p>
      <div className="project-plan-recent">
        {work.time?.businessDeadline || work.time?.reviewBy || work.time?.estimatedCompletion ? (
          <WorkTimeSummary work={work} />
        ) : recent ? (
          <>
            <strong>{workHistoryLabels[recent.action]}</strong>
            <span>
              {recent.actor.displayName} · {formatHistoryTime(recent.at)}
            </span>
          </>
        ) : (
          <span>暂无动态</span>
        )}
      </div>
    </article>
  );
}

function ProjectDependencySummary({
  work,
  availableWorks,
}: {
  readonly work: CollectiveWorkProjection;
  readonly availableWorks: readonly CollectiveWorkProjection[];
}) {
  const blocking = workBlockingPresentation(work, availableWorks);
  const dependencies = blocking ?? workDependencyPresentation(work, availableWorks);
  if (blocking?.kind === 'execution') {
    return (
      <>
        <strong>{blocking.label}</strong>
        <span>{blocking.detail}</span>
        <DependencyHistory dependencies={dependencies} />
      </>
    );
  }
  if (blocking?.kind === 'dependencies') {
    return (
      <>
        <strong>等待前置任务</strong>
        <span>{blocking.incompleteLabels.join('、')}</span>
        <CompletedDependencyHistory labels={blocking.completedLabels} />
      </>
    );
  }
  if (blocking) {
    return (
      <>
        <strong>阻塞</strong>
        <span>{blocking.detail}</span>
        <CompletedDependencyHistory labels={blocking.completedLabels} />
      </>
    );
  }
  if (dependencies.incompleteLabels.length) {
    return (
      <>
        <strong>前置任务</strong>
        <span>{[...dependencies.incompleteLabels, ...dependencies.completedLabels].join('、')}</span>
      </>
    );
  }
  if (dependencies.completedLabels.length) {
    return (
      <>
        <strong>前置已完成</strong>
        <span>{dependencies.completedLabels.join('、')}</span>
      </>
    );
  }
  return <span>无前置任务</span>;
}

function DependencyHistory({ dependencies }: { readonly dependencies: ReturnType<typeof workDependencyPresentation> }) {
  return (
    <>
      {dependencies.incompleteLabels.length > 0 && (
        <small>另有未完成前置：{dependencies.incompleteLabels.join('、')}</small>
      )}
      <CompletedDependencyHistory labels={dependencies.completedLabels} />
    </>
  );
}

function CompletedDependencyHistory({ labels }: { readonly labels: readonly string[] }) {
  return labels.length ? <small>已完成前置：{labels.join('、')}</small> : null;
}
