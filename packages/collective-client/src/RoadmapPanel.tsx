import { type ReactNode, useState } from 'react';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { RoadmapProjection } from './RoadmapProjection.js';
import { RoadmapWorkDetails } from './RoadmapWorkDetails.js';
import {
  actorName,
  formatHistoryTime,
  type RoadmapLens,
  type RoadmapViewState,
  roadmapHistoryLabels,
  visibleRoadmapWorks,
  worksForRoadmap,
} from './roadmap-view-model.js';

export function RoadmapPanel({
  roadmap,
  works,
  currentHumanId,
  humanNames = {},
  view,
  onViewChange,
  onSetDependencies,
  onSetStatus,
  onOpenSource,
  onOpenResult,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly humanNames?: Readonly<Record<string, string>>;
  readonly view?: RoadmapViewState;
  readonly onViewChange?: (view: RoadmapViewState) => void;
  readonly onSetDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) => void;
  readonly onSetStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') => void;
  readonly onOpenSource?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
  readonly onOpenResult?: (work: CollectiveWorkProjection, view: RoadmapViewState) => void;
}) {
  const [internalView, setInternalView] = useState<RoadmapViewState>({
    lens: 'stage',
    presentation: 'graph',
    scope: 'all',
  });
  const activeView = view ?? internalView;
  const updateView = (next: RoadmapViewState) => {
    if (!view) setInternalView(next);
    onViewChange?.(next);
  };
  const routeWorks = worksForRoadmap(roadmap, works);
  const visibleWorks = visibleRoadmapWorks(routeWorks, activeView, currentHumanId);
  const selectedWork = activeView.workId ? routeWorks.find((work) => work.workId === activeView.workId) : undefined;
  const setLens = (lens: RoadmapLens) => updateView({ ...activeView, lens });
  return (
    <section className="roadmap-panel" aria-label={`Roadmap · ${roadmap.title}`}>
      <header className="roadmap-heading">
        <div>
          <span>Roadmap · {roadmap.status === 'active' ? '持续更新' : '已完成'}</span>
          <h2>{roadmap.title}</h2>
          <p>{roadmap.purpose}</p>
        </div>
        {roadmap.accountableHumanId === currentHumanId && (
          <button
            type="button"
            className="roadmap-status-action"
            onClick={() => onSetStatus(roadmap, roadmap.status === 'active' ? 'completed' : 'active')}
          >
            {roadmap.status === 'active' ? '完成路线' : '重新打开路线'}
          </button>
        )}
      </header>

      <div className="roadmap-primary-bar">
        <nav aria-label="Roadmap 观察方式">
          <LensButton active={activeView.lens === 'stage'} onClick={() => setLens('stage')}>
            阶段路线
          </LensButton>
          <LensButton active={activeView.lens === 'dependencies'} onClick={() => setLens('dependencies')}>
            依赖关系
          </LensButton>
          <LensButton active={activeView.lens === 'mine'} onClick={() => setLens('mine')}>
            我的路线
          </LensButton>
        </nav>
        <details className="roadmap-history-disclosure">
          <summary aria-label="打开 Roadmap 操作历史">路线历史</summary>
          <ol>
            {[...roadmap.history].reverse().map((entry) => (
              <li key={`${entry.revision}:${entry.action}`}>
                <strong>{roadmapHistoryLabels[entry.action]}</strong>
                <span>
                  {actorName(entry.actor)} · {formatHistoryTime(entry.at)}
                </span>
                {entry.note && <p>{entry.note}</p>}
              </li>
            ))}
          </ol>
        </details>
      </div>

      {activeView.lens === 'stage' && (
        <div className="roadmap-context-bar">
          <ControlGroup label="Roadmap 呈现方式">
            <ControlButton
              active={activeView.presentation === 'graph'}
              onClick={() => updateView({ ...activeView, presentation: 'graph' })}
            >
              工作图
            </ControlButton>
            <ControlButton
              active={activeView.presentation === 'board'}
              onClick={() => updateView({ ...activeView, presentation: 'board' })}
            >
              状态看板
            </ControlButton>
          </ControlGroup>
          <ControlGroup label="Roadmap 显示范围">
            <ControlButton
              active={activeView.scope === 'focus'}
              onClick={() => updateView({ ...activeView, scope: 'focus' })}
            >
              当前重点
            </ControlButton>
            <ControlButton
              active={activeView.scope === 'all'}
              onClick={() => updateView({ ...activeView, scope: 'all' })}
            >
              全部工作
            </ControlButton>
          </ControlGroup>
        </div>
      )}

      <div className="roadmap-canvas" data-concierge-safe-zone>
        {visibleWorks.length ? (
          <RoadmapProjection
            works={visibleWorks}
            allWorks={routeWorks}
            view={activeView}
            currentHumanId={currentHumanId}
            humanNames={humanNames}
            selectedWorkId={selectedWork?.workId}
            onSelect={(workId) => updateView({ ...activeView, workId })}
          />
        ) : (
          <p className="roadmap-empty">
            {activeView.lens === 'mine' ? '这条路线还没有属于你的工作。' : '当前范围还没有工作。'}
          </p>
        )}
      </div>

      {selectedWork && (
        <RoadmapWorkDetails
          work={selectedWork}
          works={routeWorks}
          view={activeView}
          currentHumanId={currentHumanId}
          humanNames={humanNames}
          canEditDependencies={roadmap.status === 'active'}
          onSetDependencies={onSetDependencies}
          onOpenSource={onOpenSource}
          onOpenResult={onOpenResult}
          onClose={() => updateView({ ...activeView, workId: undefined })}
        />
      )}
    </section>
  );
}

function LensButton({ active, onClick, children }: ControlButtonProps) {
  return (
    <button type="button" aria-current={active ? 'page' : undefined} onClick={onClick}>
      {children}
    </button>
  );
}

function ControlGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <fieldset className="roadmap-control-group">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

interface ControlButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}

function ControlButton({ active, onClick, children }: ControlButtonProps) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}
