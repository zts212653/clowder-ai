// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the named graph application owns keyboard pan/zoom; Tab still reaches native node buttons and exits normally.
'use client';
import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';
import { type ReactNode, useId, useMemo, useRef } from 'react';
import { ExplorationIcon } from './ExplorationIcon';
import { LINEAGE_NODE_SIZE, layoutExplorationLineage, lineageDetailLevel } from './exploration-lineage';
import type { ExplorationReading } from './exploration-reading';
import { lineageLabels } from './lineage-labels';
import { useLineageCamera } from './use-lineage-camera';

type Viewport = ExplorationReading['viewport'];
export function ExplorationLineage({
  nodes,
  selected,
  currentKeys,
  nodeNotes,
  toolbarEnd,
  viewport,
  onViewport,
  onSelect,
  direction = 'map',
}: {
  nodes: EvolutionExplorationNodeV1[];
  selected?: string;
  currentKeys: Set<string>;
  nodeNotes?: ReadonlyMap<string, string>;
  toolbarEnd?: ReactNode;
  viewport: Viewport;
  onViewport(value: Viewport): void;
  onSelect(node: EvolutionExplorationNodeV1): void;
  direction?: 'map' | 'vertical';
}) {
  const instructionsId = useId();
  const drag = useRef<{ id: number; x: number; y: number; start: Viewport; moved: boolean } | null>(null);
  const positioned = useMemo(
    () => layoutExplorationLineage(nodes, viewport.collapsed, direction),
    [nodes, viewport.collapsed, direction],
  );
  const density = lineageDetailLevel(viewport.zoom);
  const { host, size } = useLineageCamera(positioned, selected, viewport, onViewport);
  const minimumZoom = Math.max(
    0.001,
    Math.min(1, size.width / positioned.width, size.height / positioned.height) * 0.8,
  );
  const labels = lineageLabels(positioned, viewport, size, selected);
  const suppressClick = useRef(false);
  const locate = () => {
    const all = layoutExplorationLineage(nodes, [], direction);
    const target = all.nodes.find((node) => node.key === selected);
    const readableZoom = Math.max(1, viewport.zoom);
    if (target)
      onViewport({
        ...viewport,
        collapsed: [],
        framing: 'manual',
        zoom: readableZoom,
        x: (host.current?.clientWidth ?? 600) / 2 - (target.x + LINEAGE_NODE_SIZE.width / 2) * readableZoom,
        y: (host.current?.clientHeight ?? 210) / 2 - (target.y + LINEAGE_NODE_SIZE.height / 2) * readableZoom,
      });
  };
  const fit = () => {
    const width = host.current?.clientWidth;
    const height = host.current?.clientHeight;
    if (!width || !height) return;
    const all = layoutExplorationLineage(nodes, [], direction);
    const scale = Math.max(0.001, Math.min(1, width / all.width, height / all.height));
    onViewport({
      ...viewport,
      collapsed: [],
      framing: 'fit',
      x: (width - all.width * scale) / 2,
      y: (height - all.height * scale) / 2,
      zoom: scale,
    });
  };
  const zoom = (delta: number) => {
    const next = Math.max(minimumZoom, Math.min(2.5, Math.round((viewport.zoom + delta) * 1000) / 1000));
    const ratio = next / viewport.zoom;
    onViewport({
      ...viewport,
      framing: 'manual',
      zoom: next,
      x: size.width / 2 - (size.width / 2 - viewport.x) * ratio,
      y: size.height / 2 - (size.height / 2 - viewport.y) * ratio,
    });
  };
  return (
    <section className="exploration-lineage" aria-label="版本谱系画布" data-density={density}>
      <div className="exploration-section-heading">
        <div className="exploration-canvas-tools" role="group" aria-label="谱系导航">
          <button
            type="button"
            aria-label="缩小谱系"
            disabled={viewport.zoom <= minimumZoom}
            onClick={() => zoom(-0.15)}
          >
            <ExplorationIcon kind="minus" />
          </button>
          <output aria-label="谱系缩放">{Math.round(viewport.zoom * 1000) / 10}%</output>
          <button type="button" aria-label="放大谱系" disabled={viewport.zoom >= 2.5} onClick={() => zoom(0.15)}>
            <ExplorationIcon kind="plus" />
          </button>
          <button type="button" onClick={fit}>
            看全图
          </button>
          <button type="button" onClick={locate} aria-label="定位阅读版">
            <ExplorationIcon kind="focus" />
            定位
          </button>
          {toolbarEnd}
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
            onViewport({ ...viewport, framing: 'manual', x: viewport.x + move[0], y: viewport.y + move[1] });
          }
          if (event.key === 'Home') {
            event.preventDefault();
            locate();
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('.exploration-fold')) return;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: viewport, moved: false };
          suppressClick.current = false;
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
          start.moved = true;
          suppressClick.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
          onViewport({
            ...start.start,
            framing: 'manual',
            x: start.start.x + event.clientX - start.x,
            y: start.start.y + event.clientY - start.y,
          });
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
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
                    d={
                      direction === 'vertical'
                        ? `M${parent.x + 88},${parent.y + 56} C${parent.x + 88},${(parent.y + item.y) / 2 + 56} ${item.x + 88},${(parent.y + item.y) / 2 + 56} ${item.x + 88},${item.y + 56}`
                        : `M${parent.x + 88},${parent.y + 56} C${(parent.x + item.x) / 2 + 88},${parent.y + 56} ${(parent.x + item.x) / 2 + 88},${item.y + 56} ${item.x + 88},${item.y + 56}`
                    }
                    vectorEffect="non-scaling-stroke"
                    style={{ strokeWidth: 1.2 / viewport.zoom }}
                  />
                );
              }),
            )}
          </svg>
          {positioned.nodes.map(({ node, key, x, y }) => (
            <div
              key={key}
              className="exploration-node-wrap"
              data-key={key}
              data-selected={key === selected}
              data-current={currentKeys.has(key)}
              data-label-side={labels.get(key)?.side ?? (x > positioned.width / 2 ? 'end' : 'start')}
              data-label-visible={labels.has(key)}
              data-label-above={labels.get(key)?.above ?? false}
              style={{ left: x + 88, top: y + 56, transform: `scale(${1 / viewport.zoom}) translate(-50%, -50%)` }}
            >
              <button
                type="button"
                className="exploration-node"
                aria-pressed={key === selected}
                aria-label={`阅读 ${node.title}`}
                title={node.summary}
                onClick={() => onSelect(node)}
              >
                <span className="sr-only">阅读 </span>
                <span className="exploration-node-title">
                  <ExplorationIcon kind={node.kind === 'owner_version' ? 'code' : 'branch'} />
                  <span>{node.title}</span>
                </span>
                <span className="exploration-node-summary">{node.changes[0]?.detail ?? node.summary}</span>
                {(currentKeys.has(key) || nodeNotes?.has(key)) && (
                  <span className="exploration-node-meta">
                    {currentKeys.has(key) ? '当前沿用' : nodeNotes?.get(key)}
                  </span>
                )}
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
        {density === 'points' ? ' 远看来源关系，放大读版本。' : ' 仅表示版本来源；成绩与条件在右侧按实验阅读。'}
        {nodes.every((node) => node.kind === 'public_archive') && ' 公开归档不表示已采用。'}
        {positioned.hiddenCount > 0 && ` ${positioned.hiddenCount} 个节点已折叠，定位可重新展开。`}
      </p>
    </section>
  );
}
