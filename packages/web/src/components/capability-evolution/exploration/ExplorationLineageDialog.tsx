import { useEffect, useRef } from 'react';
import { ExplorationLineage } from './ExplorationLineage';
import type { useExplorationWorkspace } from './use-exploration-workspace';

export function ExplorationLineageDialog({
  workspace,
  close,
  allSources = false,
  historical = false,
}: {
  workspace: ReturnType<typeof useExplorationWorkspace>;
  close(): void;
  allSources?: boolean;
  historical?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  if (!workspace.catalog) return null;
  return (
    <dialog
      ref={ref}
      className="exploration-lineage-dialog"
      aria-label="完整版本谱系"
      onClose={close}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <header>
        <h3>{historical ? '错题谱系' : '版本来源与分叉'}</h3>
        <button type="button" onClick={() => ref.current?.close()}>
          {historical ? '返回阅读' : '返回比较'}
        </button>
      </header>
      <ExplorationLineage
        nodes={
          allSources
            ? workspace.catalog.nodes
            : workspace.catalog.nodes.filter((node) => node.kind === workspace.node?.kind)
        }
        selected={workspace.selectedNodeKey}
        currentKeys={workspace.currentKeys}
        adoptedKeys={workspace.adoptedKeys}
        viewport={workspace.reading.viewport}
        direction={workspace.reading.lineageLayout ?? 'map'}
        onViewport={(viewport) => workspace.change({ viewport })}
        onSelect={workspace.selectNode}
        v2={allSources}
      />
    </dialog>
  );
}
