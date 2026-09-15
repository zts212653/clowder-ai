import { refIdentity } from '@cat-cafe/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationLineage } from './ExplorationLineage';
import type { useExplorationWorkspace } from './use-exploration-workspace';

export function ExplorationNavigation({ workspace }: { workspace: ReturnType<typeof useExplorationWorkspace> }) {
  const navigation = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = navigation.current;
    if (!element) return;
    const measure = () => setNarrow(element.clientWidth > 0 && element.clientWidth <= 700);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const {
    catalog,
    node,
    reading,
    selectNode,
    change,
    currentKeys,
    selectedNodeKey,
    selectedExperimentKey,
    experiments,
  } = workspace;
  if (!catalog || !node) return null;
  const lineageCollapsed = reading.lineageCollapsed ?? narrow;
  const experimentCounts = new Map<string, number>();
  for (const run of catalog.experiments) {
    const key = refIdentity(run.nodeRef);
    experimentCounts.set(key, (experimentCounts.get(key) ?? 0) + 1);
  }
  return (
    <>
      {catalog.nodes.some((entry) => entry.kind === 'public_archive') && (
        <div className="exploration-kind-tabs" role="group" aria-label="版本来源">
          {(['owner_version', 'public_archive'] as const).map((kind) => (
            <button
              type="button"
              aria-pressed={kind === node.kind}
              key={kind}
              disabled={!catalog.nodes.some((entry) => entry.kind === kind)}
              onClick={() => {
                const next = catalog.nodes.filter((entry) => entry.kind === kind).at(-1);
                if (next) selectNode(next);
              }}
            >
              {kind === 'owner_version' ? '本项目版本' : '公开归档'}
            </button>
          ))}
        </div>
      )}
      <div ref={navigation} className="exploration-navigation">
        <details
          className="exploration-lineage-disclosure"
          aria-label="版本谱系"
          open={!lineageCollapsed}
          onToggle={(event) => {
            const collapsed = !event.currentTarget.open;
            if (collapsed !== lineageCollapsed) change({ lineageCollapsed: collapsed });
          }}
        >
          <summary>
            <ExplorationIcon kind="branch" />
            版本谱系 · {catalog.nodes.filter((entry) => entry.kind === node.kind).length} 个节点{' '}
            <span>{lineageCollapsed ? '展开画布' : '收起画布'}</span>
          </summary>
          {!lineageCollapsed && (
            <ExplorationLineage
              nodes={catalog.nodes.filter((entry) => entry.kind === node.kind)}
              selected={selectedNodeKey}
              currentKeys={currentKeys}
              experimentCounts={experimentCounts}
              viewport={reading.viewport}
              onViewport={(viewport) => change({ viewport })}
              onSelect={selectNode}
            />
          )}
        </details>
        <section className="exploration-selected" aria-label="所选版本与实验">
          <div className="exploration-selection-heading">
            <h3>
              <ExplorationIcon kind={node.kind === 'owner_version' ? 'code' : 'branch'} />
              正在阅读 {node.title}
            </h3>
            <span data-current-adoption={currentKeys.has(selectedNodeKey ?? '')}>
              {currentKeys.has(selectedNodeKey ?? '')
                ? '当前沿用'
                : node.kind === 'public_archive'
                  ? '公开开发记录'
                  : '阅读选择'}
            </span>
          </div>
          <details className="exploration-changes">
            <summary>{node.summary}</summary>
            {node.changes.map((item, index) => (
              <p key={`${item.label}:${index}`}>
                <strong>{item.label}</strong> · {item.detail}
              </p>
            ))}
          </details>
          <div className="exploration-selectors">
            <label data-exploration-category="object">
              <ExplorationIcon kind="branch" />
              阅读版本
              <select
                aria-label="选择阅读版本"
                value={selectedNodeKey ?? ''}
                onChange={(event) => {
                  const next = catalog.nodes.find((entry) => refIdentity(entry.nodeRef) === event.target.value);
                  if (next) selectNode(next);
                }}
              >
                {catalog.nodes
                  .filter((entry) => entry.kind === node.kind)
                  .map((entry) => (
                    <option key={refIdentity(entry.nodeRef)} value={refIdentity(entry.nodeRef)}>
                      {entry.title}
                    </option>
                  ))}
              </select>
            </label>
            <label data-exploration-category="measurement">
              <ExplorationIcon kind="experiment" />
              本版实验
              <select
                aria-label="选择本版实验"
                value={selectedExperimentKey ?? ''}
                onChange={(event) => {
                  const next = experiments.find((run) => refIdentity(run.experimentRef) === event.target.value);
                  change({
                    selectedExperimentRef: next?.experimentRef,
                    comparisonExperimentRef: undefined,
                    selectedCaseId: undefined,
                    comparisonScope: 'full',
                  });
                }}
              >
                <option value="" disabled>
                  {experiments.length ? '选择一次实验' : '此版本尚未测量'}
                </option>
                {experiments.map((run) => (
                  <option key={refIdentity(run.experimentRef)} value={refIdentity(run.experimentRef)}>
                    {run.title} · {run.conditions.window.label}
                  </option>
                ))}
              </select>
            </label>
            <label data-exploration-category="rubric">
              <ExplorationIcon kind="compare" />
              对照实验
              <select
                aria-label="选择对照实验"
                value={reading.comparisonExperimentRef ? refIdentity(reading.comparisonExperimentRef) : ''}
                onChange={(event) =>
                  change({
                    comparisonExperimentRef: catalog.experiments.find(
                      (run) => refIdentity(run.experimentRef) === event.target.value,
                    )?.experimentRef,
                    comparisonScope: 'full',
                  })
                }
              >
                <option value="">暂不比较</option>
                {catalog.experiments
                  .filter((run) => refIdentity(run.experimentRef) !== selectedExperimentKey)
                  .map((run) => (
                    <option key={refIdentity(run.experimentRef)} value={refIdentity(run.experimentRef)}>
                      {run.title} · {run.recordCount} 条
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </section>
      </div>
    </>
  );
}
