import { refIdentity } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { ExplorationCover } from './ExplorationCover';
import { ExplorationIcon } from './ExplorationIcon';
import type { useExplorationWorkspace } from './use-exploration-workspace';

/** Readable overview of published nodes; parent edges and adoption come only from their owners. */
export function ExplorationVersionCards({
  workspace,
  notes,
}: {
  workspace: ReturnType<typeof useExplorationWorkspace>;
  notes: ReadonlyMap<string, string>;
}) {
  const { catalog, selectedNodeKey, currentKeys, adoptedKeys, selectNode } = workspace;
  if (!catalog) return null;
  const titles = new Map(catalog.nodes.map((node) => [refIdentity(node.nodeRef), node.title]));
  const counts = new Map<string, number>();
  for (const experiment of catalog.experiments) {
    const key = refIdentity(experiment.nodeRef);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    <div className="exploration-version-cards">
      {(['owner_version', 'public_archive'] as const).map((kind) => {
        const nodes = catalog.nodes.filter((node) => node.kind === kind);
        if (!nodes.length) return null;
        const label = kind === 'owner_version' ? '本项目版本' : '公开归档';
        return (
          <section key={kind} aria-label={label}>
            <h3>
              <ExplorationIcon kind={kind === 'owner_version' ? 'branch' : 'evidence'} />
              {label} · {nodes.length}
            </h3>
            {nodes.some((node) => node.parentEdges.length === 0) && (
              <p className="exploration-caption">目录没登记部分版本是从哪版改来的，所以不连线。</p>
            )}
            <ol className="exploration-version-card-list">
              {nodes.map((node) => {
                const key = refIdentity(node.nodeRef);
                const parents = node.parentEdges.map(
                  (edge) => titles.get(refIdentity(edge.parentNodeRef)) ?? '父版名称待来源核实',
                );
                return (
                  <li key={key} className="exploration-version-card" data-reading={selectedNodeKey === key}>
                    <button
                      type="button"
                      aria-label={`阅读 ${node.title}`}
                      aria-pressed={selectedNodeKey === key}
                      onClick={() => selectNode(node)}
                    >
                      <strong>{node.title}</strong>
                      <span className="exploration-version-card-state">
                        {currentKeys.has(key) && <span>来源当前版本</span>}
                        {adoptedKeys.has(key) && <span>当前采用</span>}
                        {selectedNodeKey === key && <span>正在读</span>}
                      </span>
                      <span>{counts.has(key) ? `${counts.get(key)} 次实验` : '尚无实验'}</span>
                      {notes.has(key) && <span>{notes.get(key)}</span>}
                    </button>
                    <ExplorationCover key={node.preview?.media.mediaRef.version} programId={workspace.id} node={node} />
                    <p>改了什么：{node.changes[0]?.detail ?? node.summary}</p>
                    {parents.length > 0 && <p>派生自：{parents.join('、')}</p>}
                    <details>
                      <summary>改动与来源 · {node.changes.length} 项</summary>
                      <p>{node.summary}</p>
                      {node.changes.map((change, index) => (
                        <div key={`${change.label}:${index}`}>
                          <h4>{change.label}</h4>
                          <p>{change.detail}</p>
                          <EvolutionSource label="改动依据" source={change.sourceRef} href={change.ownerHref} />
                        </div>
                      ))}
                      <EvolutionSource label="原件来源" source={node.sourceRef} />
                      {node.parentEdges.map((edge, index) => (
                        <EvolutionSource
                          key={`${refIdentity(edge.parentNodeRef)}:${index}`}
                          label="派生依据"
                          source={edge.sourceRef}
                        />
                      ))}
                    </details>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
