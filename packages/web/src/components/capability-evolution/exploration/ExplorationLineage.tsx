// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the named graph application owns keyboard pan/zoom; Tab still reaches native node buttons and exits normally.
'use client';
import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';
import { useEffect, useId, useMemo, useRef } from 'react';
import { ExplorationIcon } from './ExplorationIcon';
import { LINEAGE_NODE_SIZE, layoutExplorationLineage } from './exploration-lineage';
import type { ExplorationReading } from './exploration-reading';

type Viewport = ExplorationReading['viewport'];
export function ExplorationLineage({
  nodes,
  selected,
  currentKeys,
  experimentCounts,
  viewport,
  onViewport,
  onSelect,
}: {
  nodes: EvolutionExplorationNodeV1[];
  selected?: string;
  currentKeys: Set<string>;
  experimentCounts?: ReadonlyMap<string, number>;
  viewport: Viewport;
  onViewport(value: Viewport): void;
  onSelect(node: EvolutionExplorationNodeV1): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const instructionsId = useId();
  const drag = useRef<{ id: number; x: number; y: number; start: Viewport } | null>(null);
  const positioned = useMemo(() => layoutExplorationLineage(nodes, viewport.collapsed), [nodes, viewport.collapsed]);
  const latest = useRef({ viewport, onViewport });
  latest.current = { viewport, onViewport };
  const positions = useRef(positioned);
  positions.current = positioned;
  const locate = () => {
    const all = layoutExplorationLineage(nodes, []);
    const target = all.nodes.find((node) => node.key === selected);
    const readableZoom = Math.max(1, viewport.zoom);
    if (target)
      onViewport({
        ...viewport,
        collapsed: [],
        zoom: readableZoom,
        x: (host.current?.clientWidth ?? 600) / 2 - (target.x + LINEAGE_NODE_SIZE.width / 2) * readableZoom,
        y: (host.current?.clientHeight ?? 210) / 2 - (target.y + LINEAGE_NODE_SIZE.height / 2) * readableZoom,
      });
  };
  const fit = () => {
    const width = host.current?.clientWidth;
    const height = host.current?.clientHeight;
    if (!width || !height) return;
    const all = layoutExplorationLineage(nodes, []);
    const scale = Math.max(0.001, Math.min(1, width / all.width, height / all.height));
    onViewport({
      ...viewport,
      collapsed: [],
      x: (width - all.width * scale) / 2,
      y: (height - all.height * scale) / 2,
      zoom: scale,
    });
  };
  useEffect(() => {
    const target = positions.current.nodes.find((node) => node.key === selected);
    const { viewport: view, onViewport: update } = latest.current;
    const width = host.current?.clientWidth;
    const height = host.current?.clientHeight;
    if (
      target &&
      width &&
      height &&
      (target.x * view.zoom + view.x < 0 ||
        (target.x + LINEAGE_NODE_SIZE.width) * view.zoom + view.x > width ||
        target.y * view.zoom + view.y < 0 ||
        (target.y + LINEAGE_NODE_SIZE.height) * view.zoom + view.y > height)
    )
      update({
        ...view,
        x: width / 2 - (target.x + LINEAGE_NODE_SIZE.width / 2) * view.zoom,
        y: height / 2 - (target.y + LINEAGE_NODE_SIZE.height / 2) * view.zoom,
      });
  }, [selected]);
  const zoom = (delta: number) =>
    onViewport({
      ...viewport,
      zoom: Math.max(0.001, Math.min(2.5, Math.round((viewport.zoom + delta) * 1000) / 1000)),
    });
  return (
    <section className="exploration-lineage" aria-label="版本谱系画布">
      <div className="exploration-section-heading">
        <div className="exploration-canvas-tools" role="group" aria-label="谱系导航">
          <button type="button" aria-label="缩小谱系" disabled={viewport.zoom <= 0.001} onClick={() => zoom(-0.15)}>
            <ExplorationIcon kind="minus" />
          </button>
          <output aria-label="谱系缩放">{Math.round(viewport.zoom * 1000) / 10}%</output>
          <button type="button" aria-label="放大谱系" disabled={viewport.zoom >= 2.5} onClick={() => zoom(0.15)}>
            <ExplorationIcon kind="plus" />
          </button>
          <button type="button" onClick={fit}>
            看全图
          </button>
          <button type="button" onClick={locate}>
            <ExplorationIcon kind="focus" />
            定位阅读版
          </button>
        </div>
      </div>
      <div
        ref={host}
        className="exploration-canvas"
        role="application"
        aria-roledescription="版本画布"
        aria-label="可平移缩放的版本画布"
        aria-describedby={instructionsId}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const moves: Record<string, [number, number]> = {
            ArrowLeft: [40, 0],
            ArrowRight: [-40, 0],
            ArrowUp: [0, 40],
            ArrowDown: [0, -40],
          };
          const move = moves[event.key];
          if (move) {
            event.preventDefault();
            onViewport({ ...viewport, x: viewport.x + move[0], y: viewport.y + move[1] });
          }
          if (event.key === 'Home') {
            event.preventDefault();
            locate();
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: viewport };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          onViewport({
            ...start.start,
            x: start.start.x + event.clientX - start.x,
            y: start.start.y + event.clientY - start.y,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div
          className="exploration-canvas-world"
          style={{
            width: positioned.width,
            height: positioned.height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          <svg aria-hidden="true" width={positioned.width} height={positioned.height} className="exploration-edges">
            {positioned.nodes.flatMap((item) =>
              item.node.parentEdges.map((edge) => {
                const parent = positioned.nodes.find((node) => node.key === refIdentity(edge.parentNodeRef));
                if (!parent) return null;
                return (
                  <path
                    key={`${parent.key}:${item.key}`}
                    d={`M${parent.x + LINEAGE_NODE_SIZE.width},${parent.y + LINEAGE_NODE_SIZE.height / 2} C${parent.x + LINEAGE_NODE_SIZE.width + 16},${parent.y + LINEAGE_NODE_SIZE.height / 2} ${item.x - 16},${item.y + LINEAGE_NODE_SIZE.height / 2} ${item.x},${item.y + LINEAGE_NODE_SIZE.height / 2}`}
                  />
                );
              }),
            )}
          </svg>
          {positioned.nodes.map(({ node, key, x, y }) => (
            <div key={key} className="exploration-node-wrap" style={{ left: x, top: y, ...LINEAGE_NODE_SIZE }}>
              <button
                type="button"
                className="exploration-node"
                aria-pressed={key === selected}
                title={node.summary}
                onClick={() => onSelect(node)}
              >
                <span className="sr-only">阅读 </span>
                <span className="exploration-node-title">
                  <ExplorationIcon kind={node.kind === 'owner_version' ? 'code' : 'branch'} />
                  <span>{node.title}</span>
                </span>
                <span className="exploration-node-summary">{node.summary}</span>
                <span className="exploration-node-meta">
                  {experimentCounts && `${experimentCounts.get(key) ?? 0} 轮实验 · `}
                  {currentKeys.has(key) ? '当前沿用' : node.kind === 'public_archive' ? '公开归档' : '已记录版本'}
                </span>
              </button>
              {nodes.some((child) => child.parentEdges.some((edge) => refIdentity(edge.parentNodeRef) === key)) && (
                <button
                  type="button"
                  className="exploration-fold"
                  aria-label={`${viewport.collapsed.includes(key) ? '展开' : '折叠'} ${node.title} 后代`}
                  onClick={() =>
                    onViewport({
                      ...viewport,
                      collapsed: viewport.collapsed.includes(key)
                        ? viewport.collapsed.filter((entry) => entry !== key)
                        : [...viewport.collapsed, key],
                    })
                  }
                >
                  {viewport.collapsed.includes(key) ? '+' : '−'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="exploration-caption" id={instructionsId}>
        拖动画布或聚焦后使用方向键；Home 定位阅读版。
        {positioned.hiddenCount > 0 && ` ${positioned.hiddenCount} 个节点已折叠，定位可重新展开。`}
      </p>
    </section>
  );
}
