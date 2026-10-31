import typographyTokens from '@/styles/typography-tokens.json';
import type { GraphEdge, GraphNode, GraphResult } from './CollectionGraphModel';
import { humanTitle, kindFill, truncateLabel } from './CollectionGraphModel';

function displayType(node: GraphNode): string {
  return node.redacted ? '来源不可见' : (node.displayType ?? '分类没有记录');
}
const relations: Record<string, string> = {
  related_to: '相关',
  related: '相关',
  evolved_from: '沿用自',
  blocked_by: '等待',
  supersedes: '取代',
  invalidates: '使其失效',
  promoted_from: '提升自',
  wikilink: '引用',
  doc_link: '文档引用',
  feature_ref: '功能引用',
};
export function graphTitle(node: GraphNode): string {
  if (node.redacted) return '来源不可见';
  if (!node.title.trim() || node.title === node.anchor) return '标题没有记录下来';
  return humanTitle(node);
}
export function GraphTitleNode({
  node,
  centerAnchor,
  pos,
  onHover,
  onNodeClick,
}: {
  node: GraphNode;
  centerAnchor?: string;
  pos: { x: number; y: number };
  onHover: (node: GraphNode | null) => void;
  onNodeClick: (anchor: string, collectionId?: string) => void;
}) {
  const center = node.anchor === centerAnchor;
  const width = center ? 250 : 210;
  const activate = () => onNodeClick(node.anchor, node.collectionId);
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVG nodes need an SVG group for geometry and native keyboard activation.
    <g
      data-testid={`graph-node-${node.anchor}`}
      role="button"
      tabIndex={0}
      aria-label={graphTitle(node)}
      className="cursor-pointer"
      opacity={node.redacted ? 0.5 : 1}
      onClick={activate}
      onFocus={() => onHover(node)}
      onBlur={() => onHover(null)}
      onMouseEnter={() => onHover(node)}
      onMouseLeave={() => onHover(null)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      }}
    >
      <rect
        x={pos.x - width / 2}
        y={pos.y - 27}
        width={width}
        height={54}
        rx={10}
        fill="var(--console-card-bg)"
        stroke={center ? 'var(--cafe-accent)' : 'var(--console-border-soft)'}
        strokeWidth={center ? 2 : 1}
      />
      <text
        x={pos.x}
        y={pos.y - 2}
        textAnchor="middle"
        fontSize={typographyTokens.fontSizePx.sm}
        fontWeight={700}
        fill="var(--cafe-text)"
      >
        {truncateLabel(graphTitle(node), center ? 16 : 13)}
      </text>
      <text
        x={pos.x}
        y={pos.y + 17}
        textAnchor="middle"
        fontSize={typographyTokens.fontSizePx.xs}
        fill="var(--cafe-text-secondary)"
      >
        {displayType(node)}
      </text>
    </g>
  );
}
export function GraphTitleInspector({
  graph,
  selectedNode,
  selectedEdges,
  nodeByAnchor,
}: {
  graph: GraphResult;
  selectedNode: GraphNode | null;
  selectedEdges: GraphEdge[];
  nodeByAnchor: Map<string, GraphNode>;
}) {
  return (
    <aside
      data-testid="graph-side-panel"
      className="order-first min-w-0 space-y-3 rounded-md bg-[var(--console-card-bg)] p-4 lg:order-none"
    >
      <h3 className="font-semibold">{selectedNode ? graphTitle(selectedNode) : '未选择资料'}</h3>
      <p className="text-compact text-cafe-secondary">点击资料，查看它的关系。</p>
      <ul className="space-y-2 text-compact">
        {selectedEdges.map((edge) => {
          const outbound = edge.from === selectedNode?.anchor;
          const other = nodeByAnchor.get(outbound ? edge.to : edge.from);
          return (
            <li key={`${edge.from}:${edge.to}:${edge.relation}`}>
              {outbound ? '→' : '←'} {relations[edge.relation] ?? edge.relation} ·{' '}
              {other ? graphTitle(other) : '来源不可见'}
            </li>
          );
        })}
      </ul>
      {selectedEdges.length === 0 && <p className="text-compact text-cafe-secondary">暂无可见关系。</p>}
      <p className="text-compact text-cafe-secondary">
        {graph.nodes.length} 份资料 · {graph.edges.length} 条关系
      </p>
      <div className="flex flex-wrap gap-2 text-label text-cafe-secondary">
        {[...new Map(graph.nodes.map((node) => [displayType(node), node])).values()].map((node) => (
          <span key={displayType(node)} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: kindFill(node.kind) }} />
            {displayType(node)}
          </span>
        ))}
      </div>
    </aside>
  );
}
export function GraphTitleTooltip({ node }: { node: GraphNode }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-4 top-4 rounded-md bg-[var(--console-card-bg)] p-3 text-compact"
      data-testid="graph-tooltip"
    >
      {graphTitle(node)}
    </div>
  );
}
