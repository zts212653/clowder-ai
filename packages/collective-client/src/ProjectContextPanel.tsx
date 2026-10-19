import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import {
  formatHistoryTime,
  type RoadmapViewState,
  roadmapHistoryLabels,
  workHistoryLabels,
} from './roadmap-view-model.js';
import { workBlockingPresentation } from './work-blocking-presentation.js';

export function ProjectContextPanel({
  roadmap,
  works,
  availableWorks,
  view,
  onOpenSource,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly availableWorks: readonly CollectiveWorkProjection[];
  readonly view: RoadmapViewState;
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
}) {
  const completed = works.filter((work) => work.lifecycle === 'completed');
  const blocked = works.filter((work) => work.status === 'blocked');
  const activity = projectActivity(roadmap, works).slice(0, 8);
  return (
    <aside className="project-context" aria-label="项目上下文与动态">
      <header>
        <strong>上下文与动态</strong>
        <span>猫接手这个项目的任务时，先读到这些</span>
      </header>
      <dl className="project-context-facts">
        <div>
          <dt>项目目标</dt>
          <dd>{roadmap.purpose}</dd>
        </div>
        <div>
          <dt>已完成</dt>
          <dd>{completed.length ? completed.map((work) => work.title).join('、') : '还没有已完成任务'}</dd>
        </div>
        <div>
          <dt>当前阻塞</dt>
          <dd>
            {blocked.length ? blocked.map((work) => blockingSummary(work, availableWorks)).join('；') : '当前没有阻塞'}
          </dd>
        </div>
        <div>
          <dt>出处</dt>
          <dd>来自 #{roadmap.sourceLocation.channelId}</dd>
        </div>
      </dl>
      {onOpenSource && works.length > 0 && (
        <details className="project-context-sources">
          <summary>任务出处</summary>
          {works.map((work) => (
            <button key={work.workId} type="button" onClick={() => onOpenSource(work, view)}>
              <span>{work.title}</span>
              <small>#{work.sourceLocation.channelId}</small>
            </button>
          ))}
        </details>
      )}
      <section className="project-context-activity" aria-label="项目动态">
        <h3>动态</h3>
        {activity.length ? (
          <ol>
            {activity.map((item) => (
              <li key={item.key}>
                <span>{formatHistoryTime(item.at)}</span>
                <strong>{item.label}</strong>
                <p>
                  {item.actor}
                  {item.note ? ` · ${item.note}` : ''}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p>还没有项目动态。</p>
        )}
      </section>
    </aside>
  );
}

function blockingSummary(work: CollectiveWorkProjection, availableWorks: readonly CollectiveWorkProjection[]): string {
  const blocking = workBlockingPresentation(work, availableWorks);
  if (blocking?.kind === 'dependencies') return `${work.title}等待${blocking.incompleteLabels.join('、')}`;
  return `${work.title}：${blocking?.detail ?? '阻塞原因未填写'}`;
}

function projectActivity(roadmap: CollectiveRoadmapRecord, works: readonly CollectiveWorkProjection[]) {
  return [
    ...roadmap.history.map((entry) => ({
      key: `project:${entry.revision}:${entry.action}`,
      at: entry.at,
      label: roadmapHistoryLabels[entry.action],
      actor: entry.actor.displayName,
      note: entry.note,
    })),
    ...works.flatMap((work) =>
      work.history.map((entry) => ({
        key: `work:${work.workId}:${entry.revision}:${entry.action}`,
        at: entry.at,
        label: `${work.title} · ${workHistoryLabels[entry.action]}`,
        actor: entry.actor.displayName,
        note: entry.note,
      })),
    ),
  ].sort((left, right) => right.at.localeCompare(left.at));
}
