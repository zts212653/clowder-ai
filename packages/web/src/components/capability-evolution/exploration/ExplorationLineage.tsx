// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the named graph application owns keyboard pan/zoom; Tab still reaches native node buttons and exits normally.
'use client';
import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';
import { type ReactNode, useId, useMemo, useRef } from 'react';
import { ExplorationIcon } from './ExplorationIcon';
import { ExplorationLineageTools } from './ExplorationLineageTools';
import { isHistoricalStep } from './exploration-history';
import {
  historicalLineageEdgeKey,
  historicalLineageEdgeRoutes,
  LINEAGE_NODE_SIZE,
  type LineageRoutePoint,
  layoutExplorationLineage,
  layoutExplorationLineageV2,
  layoutHistoricalLineage,
  lineageDetailLevel,
  sparseLineageEdgeRoute,
} from './exploration-lineage';
import type { ExplorationReading } from './exploration-reading';
import { lineageLabels } from './lineage-labels';
import { useLineageCamera } from './use-lineage-camera';

type Viewport = ExplorationReading['viewport'];
const EMPTY_KEYS = new Set<string>();

function lineageDisplayTitle(node: EvolutionExplorationNodeV1): string {
  return isHistoricalStep(node) ? `${node.history.period} · ${node.title}` : node.title;
}

function lineageSummary(node: EvolutionExplorationNodeV1, historical: boolean): ReactNode {
  if (historical) return null;
  return <span className="exploration-node-summary">{node.changes[0]?.detail ?? node.summary}</span>;
}

function lineageNodeMeta(
  key: string,
  currentKeys: ReadonlySet<string>,
  adoptedKeys: ReadonlySet<string>,
  nodeNotes?: ReadonlyMap<string, string>,
): string | undefined {
  const labels = [];
  if (currentKeys.has(key)) labels.push('来源当前版本');
  if (adoptedKeys.has(key)) labels.push('当前采用');
  if (!labels.length && nodeNotes?.has(key)) labels.push(nodeNotes.get(key));
  return labels.filter((label): label is string => Boolean(label)).join(' · ') || undefined;
}

function positionLineage(
  nodes: EvolutionExplorationNodeV1[],
  collapsed: string[],
  direction: 'map' | 'vertical',
  v2: boolean,
) {
  if (nodes.length > 0 && nodes.every(isHistoricalStep))
    return { ...layoutHistoricalLineage(nodes, collapsed, direction), regions: [] };
  return v2
    ? layoutExplorationLineageV2(nodes, collapsed, direction)
    : { ...layoutExplorationLineage(nodes, collapsed, direction), regions: [] };
}

function edgePath(
  parent: { x: number; y: number },
  child: { x: number; y: number },
  direction: 'map' | 'vertical',
  route: ReadonlyArray<LineageRoutePoint> | null,
) {
  if (route) return route.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  if (direction === 'vertical')
    return `M${parent.x + 88},${parent.y + 56} C${parent.x + 88},${(parent.y + child.y) / 2 + 56} ${child.x + 88},${(parent.y + child.y) / 2 + 56} ${child.x + 88},${child.y + 56}`;
  return `M${parent.x + 88},${parent.y + 56} C${(parent.x + child.x) / 2 + 88},${parent.y + 56} ${(parent.x + child.x) / 2 + 88},${child.y + 56} ${child.x + 88},${child.y + 56}`;
}

export function ExplorationLineage({
  nodes,
  selected,
  currentKeys,
  adoptedKeys = EMPTY_KEYS,
  nodeNotes,
  toolbarEnd,
  viewport,
  onViewport,
  onSelect,
  direction = 'map',
  v2 = false,
}: {
  nodes: EvolutionExplorationNodeV1[];
  selected?: string;
  currentKeys: Set<string>;
  adoptedKeys?: Set<string>;
  nodeNotes?: ReadonlyMap<string, string>;
  toolbarEnd?: ReactNode;
  viewport: Viewport;
  onViewport(value: Viewport): void;
  onSelect(node: EvolutionExplorationNodeV1): void;
  direction?: 'map' | 'vertical';
  v2?: boolean;
}) {
  const historical = nodes.length > 0 && nodes.every(isHistoricalStep);
  const instructionsId = useId();
  const drag = useRef<{ id: number; x: number; y: number; start: Viewport; moved: boolean } | null>(null);
  const positioned = useMemo(
    () => positionLineage(nodes, viewport.collapsed, direction, v2),
    [nodes, viewport.collapsed, direction, v2],
  );
  const expandedPositioned = useMemo(() => positionLineage(nodes, [], direction, v2), [nodes, direction, v2]);
  const historicalRoutes = useMemo(
    () => (historical ? historicalLineageEdgeRoutes(positioned.nodes, direction) : new Map()),
    [historical, positioned.nodes, direction],
  );
  const density = lineageDetailLevel(viewport.zoom);
  const { host, size } = useLineageCamera(positioned, selected, viewport, onViewport);
  const minimumZoom = Math.max(
    0.001,
    Math.min(1, size.width / positioned.width, size.height / positioned.height) * 0.8,
  );
  const labels = lineageLabels(positioned, viewport, size, selected, v2);
  const suppressClick = useRef(false);
  const locate = () => {
    const target = expandedPositioned.nodes.find((node) => node.key === selected);
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
    const paddedWidth = expandedPositioned.width;
    const paddedHeight = expandedPositioned.height;
    const scale = Math.max(0.001, Math.min(1, width / paddedWidth, height / paddedHeight));
    onViewport({
      ...viewport,
      collapsed: [],
      framing: 'fit',
      x: (width - paddedWidth * scale) / 2,
      y: (height - paddedHeight * scale) / 2,
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
    <section
      className="exploration-lineage"
      aria-label="版本谱系画布"
      data-density={density}
      data-label-beside={v2}
      data-historical={historical}
    >
      <ExplorationLineageTools
        historical={historical}
        minimumZoom={minimumZoom}
        zoom={viewport.zoom}
        toolbarEnd={toolbarEnd}
        fit={fit}
        locate={locate}
        changeZoom={zoom}
      />
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
          {positioned.regions.map((region) => (
            <section
              key={region.key}
              className="exploration-canvas-region"
              aria-label={`谱系分组：${region.label}`}
              style={{
                left: region.left,
                top: region.top,
                width: region.width,
                height: region.height,
              }}
            >
              <h4 style={{ transform: `scale(${1 / viewport.zoom})` }}>{region.label}</h4>
            </section>
          ))}
          <svg aria-hidden="true" width={positioned.width} height={positioned.height} className="exploration-edges">
            {positioned.nodes.flatMap((item) =>
              item.node.parentEdges.map((edge) => {
                const parent = positioned.nodes.find((node) => node.key === refIdentity(edge.parentNodeRef));
                if (!parent) return null;
                const historicalRoute = historicalRoutes.get(historicalLineageEdgeKey(parent.key, item.key));
                const sparseRoute =
                  !historicalRoute && v2 && density === 'points'
                    ? sparseLineageEdgeRoute(parent, item, viewport.zoom)
                    : null;
                const route = historicalRoute ?? sparseRoute;
                return (
                  <path
                    key={`${parent.key}:${item.key}`}
                    data-edge-route={historicalRoute ? 'history-clear' : sparseRoute ? 'label-clear' : 'direct'}
                    data-parent-key={parent.key}
                    data-child-key={item.key}
                    d={edgePath(parent, item, direction, route)}
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
              data-adopted={adoptedKeys.has(key)}
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
                title={isHistoricalStep(node) ? lineageDisplayTitle(node) : node.summary}
                onClick={() => onSelect(node)}
              >
                <span className="sr-only">阅读 </span>
                <span className="exploration-node-title">
                  <ExplorationIcon kind={node.kind === 'owner_version' ? 'code' : 'branch'} />
                  <span>{lineageDisplayTitle(node)}</span>
                </span>
                {lineageSummary(node, historical)}
                {lineageNodeMeta(key, currentKeys, adoptedKeys, nodeNotes) && (
                  <span className="exploration-node-meta">
                    {lineageNodeMeta(key, currentKeys, adoptedKeys, nodeNotes)}
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
        {historical
          ? ' 点选一步，阅读当时的改变与错题。连线的理由写在正文里。'
          : density === 'points'
            ? ' 远看来源关系，放大读版本。'
            : ' 仅表示版本来源；成绩与条件在右侧按实验阅读。'}
        {!historical && nodes.every((node) => node.kind === 'public_archive') && ' 公开归档不表示已采用。'}
        {positioned.hiddenCount > 0 && ` ${positioned.hiddenCount} 个节点已折叠，定位可重新展开。`}
      </p>
    </section>
  );
}
