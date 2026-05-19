'use client';

import {
  compactAnchorLabel,
  type GraphEdge,
  type GraphNode,
  type GraphResult,
  humanTitle,
  kindFill,
  relationColor,
  truncateLabel,
} from './CollectionGraphModel';

const DIMMED_SENSITIVITIES = new Set(['private', 'restricted']);

function labelWidth(anchor: string, title: string, isCenter: boolean): number {
  const anchorWidth = [...anchor].length * 8;
  const titleWidth = [...title].length * (isCenter ? 14 : 11);
  const raw = Math.max(anchorWidth, titleWidth) + 34;
  return Math.max(isCenter ? 210 : 132, Math.min(isCenter ? 340 : 210, raw));
}

interface GraphNodeGlyphProps {
  centerAnchor: string | undefined;
  node: GraphNode;
  onHover: (n: GraphNode | null) => void;
  onNodeClick: (anchor: string, collectionId?: string) => void;
  pos: { x: number; y: number };
}

export function GraphNodeGlyph({ centerAnchor, node, onHover, onNodeClick, pos }: GraphNodeGlyphProps) {
  const glyph = glyphViewModel(node, centerAnchor, pos);

  return (
    <g
      key={node.anchor}
      data-testid={`graph-node-${node.anchor}`}
      opacity={glyph.dimmed ? 0.5 : 1}
      className="cursor-pointer"
      role="treeitem"
      tabIndex={0}
      onClick={() => onNodeClick(node.anchor, node.collectionId)}
      ref={(el) => bindSvgNodeEvents(el, node, onHover, onNodeClick)}
    >
      <rect
        x={glyph.x}
        y={glyph.y}
        width={glyph.width}
        height={glyph.height}
        rx={12}
        fill={glyph.background}
        stroke={glyph.border}
        strokeWidth={glyph.strokeWidth}
        strokeDasharray={node.kind === 'unresolved' ? '5 3' : undefined}
        filter="url(#node-shadow)"
      />
      <rect x={glyph.x} y={glyph.y} width={5} height={glyph.height} rx={2.5} fill={glyph.fill} opacity={0.95} />
      {node.redacted ? (
        <text x={glyph.x + 16} y={pos.y + 4} fontSize={13} fill="#374151" fontWeight="700">
          🔒 Redacted
        </text>
      ) : (
        <>
          <text x={glyph.x + 16} y={glyph.anchorY} fontSize={glyph.anchorSize} fill="#1f2937" fontWeight="800">
            {glyph.anchorLabel}
          </text>
          <text
            x={glyph.x + 16}
            y={glyph.titleY}
            fontSize={glyph.titleSize}
            fill="#6b7280"
            fontWeight="600"
            data-testid={`graph-node-title-${node.anchor}`}
          >
            {glyph.title}
          </text>
        </>
      )}
    </g>
  );
}

function bindSvgNodeEvents(
  el: SVGGElement | null,
  node: GraphNode,
  onHover: (n: GraphNode | null) => void,
  onNodeClick: (anchor: string, collectionId?: string) => void,
) {
  if (!el) return;
  el.onblur = () => onHover(null);
  el.onfocus = () => onHover(node);
  el.onmouseenter = () => onHover(node);
  el.onmouseleave = () => onHover(null);
  el.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onNodeClick(node.anchor, node.collectionId);
  };
}

function glyphViewModel(node: GraphNode, centerAnchor: string | undefined, pos: { x: number; y: number }) {
  const isCenter = node.anchor === centerAnchor;
  const anchorLabel = compactAnchorLabel(node.anchor);
  const title = truncateLabel(humanTitle(node), isCenter ? 18 : 13);
  const width = labelWidth(anchorLabel, title, isCenter);
  const height = isCenter ? 54 : 46;
  const y = pos.y - height / 2;
  const dimmed = node.redacted ? true : DIMMED_SENSITIVITIES.has(node.sensitivity);
  return {
    anchorLabel,
    anchorSize: isCenter ? 13 : 11,
    anchorY: isCenter ? y + 21 : y + 19,
    background: isCenter ? '#eff6ff' : node.kind === 'unresolved' ? '#f3f4f6' : '#fffdf8',
    border: isCenter ? '#2563eb' : '#d6cabc',
    dimmed,
    fill: kindFill(node.kind),
    height,
    strokeWidth: isCenter ? 2.5 : 1.5,
    title,
    titleSize: isCenter ? 12 : 10,
    titleY: isCenter ? y + 40 : y + 35,
    width,
    x: pos.x - width / 2,
    y,
  };
}

interface GraphInspectorProps {
  graph: GraphResult;
  hiddenRelations: Set<string>;
  nodeByAnchor: Map<string, GraphNode>;
  selectedEdges: GraphEdge[];
  selectedNode: GraphNode | null;
  toggleRelation: (rel: string) => void;
  uniqueKinds: string[];
  uniqueRelations: string[];
}

export function GraphInspector({
  graph,
  hiddenRelations,
  nodeByAnchor,
  selectedEdges,
  selectedNode,
  toggleRelation,
  uniqueKinds,
  uniqueRelations,
}: GraphInspectorProps) {
  return (
    <div data-testid="graph-side-panel" className="min-w-0 space-y-4 rounded-md bg-[var(--console-card-bg)] p-4">
      <div data-testid="graph-node-detail" className="space-y-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-cafe-secondary">Selected node</div>
          <div className="mt-1 text-sm font-black text-cafe-primary">
            {selectedNode ? selectedNode.anchor : 'No node'}
          </div>
          <div className="mt-1 text-xs font-semibold text-cafe-secondary">
            {selectedNode ? humanTitle(selectedNode) : ''}
          </div>
        </div>
        {selectedNode && <SelectedNodeMeta node={selectedNode} />}
        <SelectedRelations edges={selectedEdges} node={selectedNode} nodeByAnchor={nodeByAnchor} />
      </div>
      <GraphSummary graph={graph} />
      <GraphLegend uniqueKinds={uniqueKinds} />
      {uniqueRelations.length > 1 && (
        <GraphEdgeFilter
          hiddenRelations={hiddenRelations}
          toggleRelation={toggleRelation}
          uniqueRelations={uniqueRelations}
        />
      )}
    </div>
  );
}

function SelectedNodeMeta({ node }: { node: GraphNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-[10px] text-cafe-secondary">
      <span>类型</span>
      <span className="font-semibold text-cafe-primary">{node.kind}</span>
      <span>集合</span>
      <span className="font-semibold text-cafe-primary">{node.collectionId}</span>
      <span>敏感级别</span>
      <span className="font-semibold text-cafe-primary">{node.sensitivity}</span>
    </div>
  );
}

function SelectedRelations({
  edges,
  node,
  nodeByAnchor,
}: {
  edges: GraphEdge[];
  node: GraphNode | null;
  nodeByAnchor: Map<string, GraphNode>;
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-cafe-secondary">关系</div>
      <div className="mt-2 space-y-1">
        {edges.length === 0 && <div className="text-[10px] text-cafe-secondary">暂无可见关系。</div>}
        {edges.slice(0, 8).map((edge) => (
          <RelationRow
            edge={edge}
            key={`${edge.from}-${edge.to}-${edge.relation}`}
            node={node}
            nodeByAnchor={nodeByAnchor}
          />
        ))}
      </div>
    </div>
  );
}

function RelationRow({
  edge,
  node,
  nodeByAnchor,
}: {
  edge: GraphEdge;
  node: GraphNode | null;
  nodeByAnchor: Map<string, GraphNode>;
}) {
  const outbound = edge.from === node?.anchor;
  const otherAnchor = outbound ? edge.to : edge.from;
  const other = nodeByAnchor.get(otherAnchor);
  return (
    <div className="text-[10px] text-cafe-secondary">
      <span className="font-bold text-cafe-primary">
        {outbound ? '→' : '←'} {edge.relation.replace(/_/g, ' ')}
      </span>{' '}
      <span>{otherAnchor}</span>
      {other && <span> · {truncateLabel(humanTitle(other), 18)}</span>}
    </div>
  );
}

function GraphSummary({ graph }: { graph: GraphResult }) {
  return (
    <div className="border-t border-[#eee3d6] pt-3 text-[10px] text-cafe-secondary" data-testid="graph-summary">
      <div className="flex flex-wrap gap-3">
        <span>节点: {graph.nodes.length}</span>
        <span>关系边: {graph.edges.length}</span>
        <span>深度: {graph.depth}</span>
        {graph.center && <span>中心: {graph.center}</span>}
      </div>
    </div>
  );
}

function GraphLegend({ uniqueKinds }: { uniqueKinds: string[] }) {
  return (
    <div className="border-t border-[#eee3d6] pt-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-cafe-secondary">图例</div>
      <div className="flex flex-wrap items-center gap-2" data-testid="graph-legend">
        {uniqueKinds.map((k) => (
          <span key={k} className="flex items-center gap-1 text-[10px] text-cafe-secondary">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: kindFill(k) }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

function GraphEdgeFilter({
  hiddenRelations,
  toggleRelation,
  uniqueRelations,
}: {
  hiddenRelations: Set<string>;
  toggleRelation: (rel: string) => void;
  uniqueRelations: string[];
}) {
  return (
    <div className="border-t border-[#eee3d6] pt-3 text-[10px] text-cafe-secondary" data-testid="graph-edge-filter">
      <div className="mb-2 font-bold uppercase tracking-wide">关系类型</div>
      <div className="flex flex-wrap items-center gap-2">
        {uniqueRelations.map((rel) => (
          <label key={rel} className="flex items-center gap-0.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!hiddenRelations.has(rel)}
              onChange={() => toggleRelation(rel)}
              className="w-3 h-3 accent-cafe-primary"
            />
            <span style={{ color: relationColor(rel) }}>{rel.replace(/_/g, ' ')}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function GraphTooltip({ node }: { node: GraphNode }) {
  return (
    <div
      data-testid="graph-tooltip"
      className="absolute inset-x-4 top-4 sm:left-auto sm:right-4 sm:max-w-xs rounded-lg bg-cafe-surface p-3 text-xs shadow-lg pointer-events-none"
    >
      <div className="font-semibold text-cafe-primary">{node.title}</div>
      <div className="text-cafe-secondary">{node.kind}</div>
      <div className="text-cafe-secondary">{node.collectionId}</div>
      <div className="text-cafe-secondary">{node.sensitivity}</div>
    </div>
  );
}
