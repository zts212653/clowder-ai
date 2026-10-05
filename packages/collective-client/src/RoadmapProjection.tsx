import type { CollectiveWorkProjection } from './client-types.js';
import { RoadmapWorkNode } from './RoadmapWorkNode.js';
import {
  dependencyLevels,
  type RoadmapViewState,
  roadmapStatusTone,
  stageForWork,
  stageLabels,
} from './roadmap-view-model.js';

export function RoadmapProjection({
  works,
  allWorks,
  view,
  currentHumanId,
  humanNames,
  selectedWorkId,
  onSelect,
}: {
  readonly works: readonly CollectiveWorkProjection[];
  readonly allWorks: readonly CollectiveWorkProjection[];
  readonly view: RoadmapViewState;
  readonly currentHumanId: string;
  readonly humanNames: Readonly<Record<string, string>>;
  readonly selectedWorkId?: string;
  readonly onSelect: (workId: string) => void;
}) {
  if (view.lens === 'dependencies') {
    return (
      <DependencyGraph
        works={works}
        allWorks={allWorks}
        humanNames={humanNames}
        selectedWorkId={selectedWorkId}
        onSelect={onSelect}
      />
    );
  }
  if (view.lens === 'mine') {
    return (
      <section className="roadmap-mine" aria-label="我的路线">
        <p>只看你负责或由你家伙伴推进的工作。</p>
        <div className="roadmap-mine-track">
          {works.map((work) => (
            <RoadmapWorkNode
              key={work.workId}
              work={work}
              humanNames={humanNames}
              selected={selectedWorkId === work.workId}
              responsibility={
                work.accountableHumanId === currentHumanId
                  ? '由我负责'
                  : `${work.assignment?.displayName ?? '我家伙伴'}推进`
              }
              onSelect={onSelect}
            />
          ))}
        </div>
      </section>
    );
  }
  return view.presentation === 'board' ? (
    <StatusBoard works={works} humanNames={humanNames} selectedWorkId={selectedWorkId} onSelect={onSelect} />
  ) : (
    <StageRoute works={works} humanNames={humanNames} selectedWorkId={selectedWorkId} onSelect={onSelect} />
  );
}

function StageRoute({ works, humanNames, selectedWorkId, onSelect }: ProjectionProps) {
  const stages = ['queued', 'active', 'accepted'] as const;
  return (
    <section className="roadmap-stage-route" aria-label="Roadmap 工作图">
      {stages.map((stage) => {
        const stageWorks = works.filter((work) => stageForWork(work.status) === stage);
        return (
          <section key={stage} className="roadmap-stage" data-stage={stage}>
            <header>
              <strong>{stageLabels[stage]}</strong>
              <span>{stageWorks.length}</span>
            </header>
            <div className="roadmap-stage-items">
              {stageWorks.length ? (
                stageWorks.map((work) => (
                  <RoadmapWorkNode
                    key={work.workId}
                    work={work}
                    humanNames={humanNames}
                    selected={selectedWorkId === work.workId}
                    onSelect={onSelect}
                  />
                ))
              ) : (
                <p>这一段暂时没有工作。</p>
              )}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function StatusBoard({ works, humanNames, selectedWorkId, onSelect }: ProjectionProps) {
  const lanes = [
    { tone: 'blocked', label: '受阻' },
    { tone: 'active', label: '推进中' },
    { tone: 'queued', label: '等待' },
    { tone: 'accepted', label: '已完成' },
  ] as const;
  return (
    <section className="roadmap-status-board" aria-label="Roadmap 状态看板">
      {lanes.map(({ tone, label }) => {
        const laneWorks = works.filter((work) => roadmapStatusTone(work.status) === tone);
        return (
          <section key={tone} className="roadmap-board-lane" data-status-tone={tone}>
            <header>
              <strong>{label}</strong>
              <span>{laneWorks.length}</span>
            </header>
            {laneWorks.map((work) => (
              <RoadmapWorkNode
                key={work.workId}
                work={work}
                humanNames={humanNames}
                selected={selectedWorkId === work.workId}
                onSelect={onSelect}
              />
            ))}
          </section>
        );
      })}
    </section>
  );
}

function DependencyGraph({
  works,
  allWorks,
  humanNames,
  selectedWorkId,
  onSelect,
}: ProjectionProps & { readonly allWorks: readonly CollectiveWorkProjection[] }) {
  const levels = dependencyLevels(works);
  const levelValues = [...new Set(levels.values())].sort((left, right) => left - right);
  const byId = new Map(allWorks.map((work) => [work.workId, work]));
  return (
    <section className="roadmap-dependency-graph" aria-label="依赖工作图">
      {levelValues.map((level) => (
        <section
          key={`dependency-level:${level}`}
          className="roadmap-dependency-level"
          aria-label={`依赖层级 ${level + 1}`}
        >
          {works
            .filter((work) => levels.get(work.workId) === level)
            .map((work) => {
              const dependencies = work.dependencyWorkIds
                .map((workId) => byId.get(workId)?.title)
                .filter((title): title is string => Boolean(title));
              return (
                <div key={work.workId} data-dependency-level={level}>
                  <RoadmapWorkNode
                    work={work}
                    humanNames={humanNames}
                    selected={selectedWorkId === work.workId}
                    responsibility={dependencies.length ? `等待 ${dependencies.join('、')}` : '没有前置工作'}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
        </section>
      ))}
    </section>
  );
}

interface ProjectionProps {
  readonly works: readonly CollectiveWorkProjection[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly selectedWorkId?: string;
  readonly onSelect: (workId: string) => void;
}
