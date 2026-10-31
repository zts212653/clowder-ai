import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';

export const LINEAGE_NODE_SIZE = { width: 176, height: 112 };
// Historical geometry reserves the largest rendered card. Cards without an
// origin/current note stay compact in CSS while annotated cards use the full
// height, so edge routing and camera bounds never undercount visible content.
export const HISTORICAL_LINEAGE_NODE_SIZE = { width: 136, height: 128 };
export const HISTORICAL_LINEAGE_MIN_ZOOM = 0.9;
// Historical cards keep a fixed readable screen width while the canvas zooms.
// At the 0.9 readability floor, 176 world pixels leave 22.4 visible pixels
// between 136px cards, so an authored adjacent edge reads as a line, not a divider.
const HISTORICAL_LINEAGE_COLUMN_GAP = 176;
// The largest fixed-screen 128px cards still keep a ~23px vertical gap at 0.9 zoom.
const HISTORICAL_LINEAGE_ROW_GAP = 168;

export interface LineageRoutePoint {
  x: number;
  y: number;
}

export interface ExplorationPositionedNode extends LineageRoutePoint {
  node: EvolutionExplorationNodeV1;
  key: string;
}

export interface ExplorationLineageRegion {
  key: 'owner' | 'registered' | 'parentless' | 'cortex';
  label: string;
  nodeKeys: string[];
  left: number;
  top: number;
  width: number;
  height: number;
}

export function lineageDetailLevel(zoom: number) {
  return zoom < 0.6 ? 'points' : zoom < 1.15 ? 'compact' : 'detail';
}

/** Topological, stable source order. Neither outcomes nor selection move a version into a better place. */
export function layoutExplorationLineage(
  nodes: EvolutionExplorationNodeV1[],
  collapsed: string[],
  direction: 'map' | 'vertical' = 'map',
) {
  const byKey = new Map(nodes.map((node) => [refIdentity(node.nodeRef), node]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const hidden = new Set<string>();
  const folded = new Set(collapsed);
  const level = (key: string): number => {
    if (levels.has(key)) return levels.get(key) ?? 0;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parents = byKey.get(key)?.parentEdges.map((edge) => refIdentity(edge.parentNodeRef)) ?? [];
    const depth = parents.length ? Math.max(...parents.map(level)) + 1 : 0;
    if (parents.some((parent) => folded.has(parent) || hidden.has(parent))) hidden.add(key);
    visiting.delete(key);
    levels.set(key, depth);
    return depth;
  };
  for (const key of byKey.keys()) level(key);
  const visible = nodes.filter((node) => !hidden.has(refIdentity(node.nodeRef)));
  const generationSizes = new Map<number, number>();
  for (const node of visible) {
    const depth = levels.get(refIdentity(node.nodeRef)) ?? 0;
    generationSizes.set(depth, (generationSizes.get(depth) ?? 0) + 1);
  }
  const breadth = Math.max(1, ...generationSizes.values());
  const depthCount = Math.max(1, ...generationSizes.keys());
  // Wide generations need room between layers; grades and the selected node never influence geometry.
  const layerGap = breadth >= 8 ? Math.max(208, (breadth * 144 * 3) / depthCount) : 208;
  const rows = new Map<number, number>();
  const placed = visible.map((node) => {
    const key = refIdentity(node.nodeRef);
    const depth = levels.get(key) ?? 0;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    const position = ((row + 0.5) * breadth) / (generationSizes.get(depth) ?? 1) - 0.5;
    return {
      node,
      key,
      x: 24 + (direction === 'vertical' ? position * 208 : depth * layerGap),
      y: 24 + (direction === 'vertical' ? depth : position) * 144,
    };
  });
  return {
    nodes: placed,
    width: Math.max(240, ...placed.map((node) => node.x + LINEAGE_NODE_SIZE.width + 24)),
    height: Math.max(160, ...placed.map((node) => node.y + LINEAGE_NODE_SIZE.height + 24)),
    hiddenCount: hidden.size,
  };
}

/** Authored history keeps publication order as time: later steps always move
 * right. Geometry never adds an edge; every visible relationship remains the
 * owner's source-backed parentEdge. Independent starts receive their own lane. */
export function layoutHistoricalLineage(
  nodes: EvolutionExplorationNodeV1[],
  collapsed: string[],
  direction: 'map' | 'vertical' = 'map',
) {
  const hidden = new Set<string>();
  const folded = new Set(collapsed);
  const lanes = new Map<string, number>();
  let nextRootLane = 0;
  const positioned: ExplorationPositionedNode[] = [];

  nodes.forEach((node, index) => {
    const key = refIdentity(node.nodeRef);
    const parents = node.parentEdges.map((edge) => refIdentity(edge.parentNodeRef));
    if (parents.some((parent) => folded.has(parent) || hidden.has(parent))) {
      hidden.add(key);
      return;
    }
    const firstKnownParent = parents.find((parent) => lanes.has(parent));
    const lane = firstKnownParent === undefined ? nextRootLane++ : (lanes.get(firstKnownParent) ?? 0);
    lanes.set(key, lane);
    positioned.push({
      node,
      key,
      x: 24 + (direction === 'vertical' ? lane * HISTORICAL_LINEAGE_COLUMN_GAP : index * HISTORICAL_LINEAGE_COLUMN_GAP),
      y: 24 + (direction === 'vertical' ? index * HISTORICAL_LINEAGE_ROW_GAP : lane * HISTORICAL_LINEAGE_ROW_GAP),
    });
  });

  const routePoints = [...historicalLineageEdgeRoutes(positioned, direction).values()].flat();
  return {
    nodes: positioned,
    width: Math.max(
      240,
      ...positioned.map((node) => node.x + HISTORICAL_LINEAGE_NODE_SIZE.width + 24),
      ...routePoints.map((point) => point.x + 24),
    ),
    height: Math.max(
      160,
      ...positioned.map((node) => node.y + HISTORICAL_LINEAGE_NODE_SIZE.height + 24),
      ...routePoints.map((point) => point.y + 24),
    ),
    hiddenCount: hidden.size,
  };
}

export const historicalLineageEdgeKey = (parentKey: string, childKey: string) => JSON.stringify([parentKey, childKey]);

/** Route only source edges that skip authored steps through independent channels
 * outside every intervening node. Adjacent edges remain direct and branches stay
 * distinguishable without inventing chronological adjacency. */
export function historicalLineageEdgeRoutes(
  nodes: ReadonlyArray<ExplorationPositionedNode>,
  direction: 'map' | 'vertical' = 'map',
) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const axisCenter = (node: ExplorationPositionedNode) =>
    direction === 'map'
      ? node.x + HISTORICAL_LINEAGE_NODE_SIZE.width / 2
      : node.y + HISTORICAL_LINEAGE_NODE_SIZE.height / 2;
  const routed = nodes
    .flatMap((child) =>
      child.node.parentEdges.flatMap((edge) => {
        const parent = byKey.get(refIdentity(edge.parentNodeRef));
        if (!parent) return [];
        const start = axisCenter(parent);
        const end = axisCenter(child);
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        const skipsStep = nodes.some(
          (node) =>
            node.key !== parent.key && node.key !== child.key && axisCenter(node) > low && axisCenter(node) < high,
        );
        return skipsStep
          ? [
              {
                child,
                end: high,
                key: historicalLineageEdgeKey(parent.key, child.key),
                parent,
                start: low,
              },
            ]
          : [];
      }),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key));
  const channelIntervals: Array<Array<[number, number]>> = [];
  const result = new Map<string, LineageRoutePoint[]>();
  for (const edge of routed) {
    let channel = channelIntervals.findIndex((intervals) =>
      intervals.every(([start, end]) => edge.end <= start || edge.start >= end),
    );
    if (channel < 0) {
      channel = channelIntervals.length;
      channelIntervals.push([]);
    }
    channelIntervals[channel].push([edge.start, edge.end]);
    const spanned = nodes.filter((node) => {
      const center = axisCenter(node);
      return center >= edge.start && center <= edge.end;
    });
    if (direction === 'map') {
      const start = {
        x: edge.parent.x + HISTORICAL_LINEAGE_NODE_SIZE.width / 2,
        y: edge.parent.y + HISTORICAL_LINEAGE_NODE_SIZE.height / 2,
      };
      const end = {
        x: edge.child.x + HISTORICAL_LINEAGE_NODE_SIZE.width / 2,
        y: edge.child.y + HISTORICAL_LINEAGE_NODE_SIZE.height / 2,
      };
      const laneY =
        Math.max(...spanned.map((node) => node.y + HISTORICAL_LINEAGE_NODE_SIZE.height)) + 48 + channel * 20;
      result.set(edge.key, [start, { x: start.x, y: laneY }, { x: end.x, y: laneY }, end]);
      continue;
    }
    const start = {
      x: edge.parent.x + HISTORICAL_LINEAGE_NODE_SIZE.width / 2,
      y: edge.parent.y + HISTORICAL_LINEAGE_NODE_SIZE.height / 2,
    };
    const end = {
      x: edge.child.x + HISTORICAL_LINEAGE_NODE_SIZE.width / 2,
      y: edge.child.y + HISTORICAL_LINEAGE_NODE_SIZE.height / 2,
    };
    const laneX = Math.max(...spanned.map((node) => node.x + HISTORICAL_LINEAGE_NODE_SIZE.width)) + 48 + channel * 20;
    result.set(edge.key, [start, { x: laneX, y: start.y }, { x: laneX, y: end.y }, end]);
  }
  return result;
}

const CORTEX_ARCHIVE_PREFIX = 'cortex-archive-container:';

/**
 * The v2 overview keeps source classes inside the canvas instead of asking an
 * external legend to explain one visually continuous column. Date/order never
 * changes the grouping: only owner kind and recorded parent-edge structure do.
 */
export function layoutExplorationLineageV2(
  nodes: EvolutionExplorationNodeV1[],
  collapsed: string[],
  direction: 'map' | 'vertical' = 'map',
) {
  const referencedParents = new Set(
    nodes.flatMap((node) => node.parentEdges.map((edge) => refIdentity(edge.parentNodeRef))),
  );
  const groups = [
    {
      key: 'owner' as const,
      label: '本项目版本',
      matches: (node: EvolutionExplorationNodeV1) => node.kind === 'owner_version',
    },
    {
      key: 'registered' as const,
      label: '公开归档 · 已登记派生',
      matches: (node: EvolutionExplorationNodeV1) =>
        node.kind === 'public_archive' &&
        !node.nodeRef.ownerStateRef.startsWith(CORTEX_ARCHIVE_PREFIX) &&
        (node.parentEdges.length > 0 || referencedParents.has(refIdentity(node.nodeRef))),
    },
    {
      key: 'parentless' as const,
      label: '公开归档 · 父版未登记',
      matches: (node: EvolutionExplorationNodeV1) =>
        node.kind === 'public_archive' &&
        !node.nodeRef.ownerStateRef.startsWith(CORTEX_ARCHIVE_PREFIX) &&
        node.parentEdges.length === 0 &&
        !referencedParents.has(refIdentity(node.nodeRef)),
    },
    {
      key: 'cortex' as const,
      label: 'Cortex · 比赛归档',
      matches: (node: EvolutionExplorationNodeV1) => node.nodeRef.ownerStateRef.startsWith(CORTEX_ARCHIVE_PREFIX),
    },
  ];
  const positioned: ReturnType<typeof layoutExplorationLineage>['nodes'] = [];
  const regions: ExplorationLineageRegion[] = [];
  let hiddenCount = 0;
  let cursorY = 16;
  let width = 240;

  for (const group of groups) {
    const members = nodes.filter(group.matches);
    if (!members.length) continue;
    const local = layoutExplorationLineage(members, collapsed, direction);
    hiddenCount += local.hiddenCount;
    const top = cursorY;
    const contentOffsetY = top + 36;
    const nodeKeys = local.nodes.map((entry) => entry.key);
    positioned.push(...local.nodes.map((entry) => ({ ...entry, y: entry.y + contentOffsetY })));
    const regionWidth = local.width + 184;
    const regionHeight = local.height + 52;
    regions.push({
      key: group.key,
      label: group.label,
      nodeKeys,
      left: 8,
      top,
      width: regionWidth,
      height: regionHeight,
    });
    width = Math.max(width, regionWidth + 16);
    cursorY += regionHeight + 28;
  }

  return {
    nodes: positioned,
    regions,
    width,
    height: Math.max(160, cursorY - 12),
    hiddenCount,
  };
}

/** Sparse v2 labels live to the right of fixed-size points, so edges leave and
 * enter on the left and use a lower lane instead of visually cutting a name. */
export function sparseLineageEdgeRoute(
  parent: Pick<LineageRoutePoint, 'x' | 'y'>,
  child: Pick<LineageRoutePoint, 'x' | 'y'>,
  zoom: number,
): LineageRoutePoint[] {
  const safeZoom = Math.max(0.001, zoom);
  const parentCenter = { x: parent.x + LINEAGE_NODE_SIZE.width / 2, y: parent.y + LINEAGE_NODE_SIZE.height / 2 };
  const childCenter = { x: child.x + LINEAGE_NODE_SIZE.width / 2, y: child.y + LINEAGE_NODE_SIZE.height / 2 };
  const portOffset = 12 / safeZoom;
  const laneY = Math.max(parentCenter.y, childCenter.y) + 26 / safeZoom;
  return [
    parentCenter,
    { x: parentCenter.x - portOffset, y: parentCenter.y },
    { x: parentCenter.x - portOffset, y: laneY },
    { x: childCenter.x - portOffset, y: laneY },
    { x: childCenter.x - portOffset, y: childCenter.y },
    childCenter,
  ];
}
