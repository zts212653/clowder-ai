import { refIdentity } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationLineage } from './ExplorationLineage';
import { ExplorationLineageDialog } from './ExplorationLineageDialog';
import type { useExplorationWorkspace } from './use-exploration-workspace';

export function ExplorationNavigation({ workspace }: { workspace: ReturnType<typeof useExplorationWorkspace> }) {
  const [graph, setGraph] = useState(false);
  const { catalog, node, selectedNodeKey, selectNode, currentKeys, reading, change } = workspace;
  const notes = useMemo(() => {
    const result = new Map<string, string>();
    for (const entry of catalog?.nodes ?? []) {
      const key = refIdentity(entry.nodeRef);
      const runs = (catalog?.experiments ?? []).filter((run) => refIdentity(run.nodeRef) === key);
      const failed = runs.filter((run) => run.status === 'failed').length;
      const active = runs.filter((run) => run.status === 'running').length;
      if (failed || active)
        result.set(key, [failed && `${failed} 次未完成`, active && `${active} 次运行中`].filter(Boolean).join(' · '));
    }
    return result;
  }, [catalog]);
  if (!catalog || !node) return null;
  const nodes = catalog.nodes.filter((entry) => entry.kind === node.kind);
  const open = reading.lineageCollapsed === false;
  return (
    <aside className="exploration-version-nav" aria-label="版本导航" data-map-open={open}>
      <div className="exploration-nav-heading">
        <button
          type="button"
          className="exploration-map-toggle"
          aria-expanded={open}
          onClick={(event) =>
            change({
              lineageCollapsed: open,
              ...(!open && !reading.lineageLayout && (event.currentTarget.closest('aside')?.clientWidth ?? 1000) < 500
                ? { lineageLayout: 'vertical', viewport: { ...reading.viewport, framing: 'fit' } }
                : {}),
            })
          }
        >
          {open ? '收起地图' : '展开地图'}
        </button>
        {!open && (
          <button type="button" onClick={() => setGraph(true)}>
            完整谱系
          </button>
        )}
      </div>
      <label className="exploration-version-picker">
        <span className="sr-only">阅读版本</span>
        <select
          aria-label="选择阅读版本"
          value={selectedNodeKey}
          onChange={(event) => {
            const next = catalog.nodes.find((item) => refIdentity(item.nodeRef) === event.target.value);
            if (next) selectNode(next);
          }}
        >
          {(['owner_version', 'public_archive'] as const).map((kind) => (
            <optgroup key={kind} label={kind === 'owner_version' ? '本项目版本' : '公开归档'}>
              {catalog.nodes
                .filter((entry) => entry.kind === kind)
                .map((entry) => (
                  <option key={refIdentity(entry.nodeRef)} value={refIdentity(entry.nodeRef)}>
                    {entry.title}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="exploration-embedded-map" data-open={open}>
        {!graph && (
          <ExplorationLineage
            nodes={nodes}
            selected={selectedNodeKey}
            currentKeys={currentKeys}
            nodeNotes={notes}
            toolbarEnd={
              <>
                {catalog.nodes.some((entry) => entry.kind !== node.kind) && (
                  <select
                    aria-label="版本来源"
                    value={node.kind}
                    onChange={(event) => {
                      const next = catalog.nodes.filter((entry) => entry.kind === event.target.value).at(-1);
                      if (next) {
                        selectNode(next);
                        change({ viewport: { ...reading.viewport, framing: 'fit', collapsed: [] } });
                      }
                    }}
                  >
                    <option value="owner_version">本项目版本</option>
                    <option value="public_archive">公开归档</option>
                  </select>
                )}
                <select
                  aria-label="谱系排列"
                  value={reading.lineageLayout ?? 'map'}
                  onChange={(event) =>
                    change({
                      lineageLayout: event.target.value as 'map' | 'vertical',
                      viewport: { ...reading.viewport, framing: 'fit' },
                    })
                  }
                >
                  <option value="map">来源关系</option>
                  <option value="vertical">纵向阅读</option>
                </select>
                <button type="button" aria-label="完整谱系" title="完整谱系" onClick={() => setGraph(true)}>
                  <ExplorationIcon kind="expand" />
                </button>
              </>
            }
            viewport={reading.viewport}
            direction={reading.lineageLayout ?? 'map'}
            onViewport={(viewport) => change({ viewport })}
            onSelect={selectNode}
          />
        )}
      </div>
      {graph && <ExplorationLineageDialog workspace={workspace} close={() => setGraph(false)} />}
    </aside>
  );
}
