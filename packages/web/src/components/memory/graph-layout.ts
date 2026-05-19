export function forceLayout(
  nodes: Array<{ anchor: string }>,
  edges: Array<{ from: string; to: string }>,
  center: string | undefined,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) return new Map();
  const useHubLayout = usesReadableHubLayout(nodes, edges, center);
  const layoutHeight = useHubLayout ? readableHubLayoutHeight(nodes.length, height) : height;
  if (useHubLayout && center) return readableHubLayout(nodes, center, width, layoutHeight);

  const cx = width / 2;
  const cy = layoutHeight / 2;
  const sim = nodes.map((n, i) => {
    if (n.anchor === center) return { x: cx, y: cy, vx: 0, vy: 0 };
    const a = (2 * Math.PI * i) / Math.max(nodes.length, 1);
    return { x: cx + 120 * Math.cos(a), y: cy + 120 * Math.sin(a), vx: 0, vy: 0 };
  });
  const idx = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) idx.set(nodes[i].anchor, i);

  simulateForces(sim, edges, idx, width, layoutHeight, cx, cy);

  const result = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < nodes.length; i++) result.set(nodes[i].anchor, { x: sim[i].x, y: sim[i].y });
  return result;
}

function simulateForces(
  sim: Array<{ x: number; y: number; vx: number; vy: number }>,
  edges: Array<{ from: string; to: string }>,
  idx: Map<string, number>,
  width: number,
  height: number,
  cx: number,
  cy: number,
) {
  for (let t = 0; t < 120; t++) {
    applyRepulsion(sim);
    applyEdgePull(sim, edges, idx);
    settle(sim, width, height, cx, cy);
  }
}

function applyRepulsion(sim: Array<{ x: number; y: number; vx: number; vy: number }>) {
  for (let i = 0; i < sim.length; i++) {
    for (let j = i + 1; j < sim.length; j++) {
      const dx = sim[i].x - sim[j].x;
      const dy = sim[i].y - sim[j].y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = 5000 / (d * d);
      sim[i].vx += (dx / d) * f;
      sim[i].vy += (dy / d) * f;
      sim[j].vx -= (dx / d) * f;
      sim[j].vy -= (dy / d) * f;
    }
  }
}

function applyEdgePull(
  sim: Array<{ x: number; y: number; vx: number; vy: number }>,
  edges: Array<{ from: string; to: string }>,
  idx: Map<string, number>,
) {
  for (const e of edges) {
    const ai = idx.get(e.from);
    const bi = idx.get(e.to);
    if (ai === undefined || bi === undefined) continue;
    const dx = sim[bi].x - sim[ai].x;
    const dy = sim[bi].y - sim[ai].y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const disp = d - 160;
    sim[ai].vx += 0.01 * disp * (dx / d);
    sim[ai].vy += 0.01 * disp * (dy / d);
    sim[bi].vx -= 0.01 * disp * (dx / d);
    sim[bi].vy -= 0.01 * disp * (dy / d);
  }
}

function settle(
  sim: Array<{ x: number; y: number; vx: number; vy: number }>,
  width: number,
  height: number,
  cx: number,
  cy: number,
) {
  const pad = 40;
  for (const p of sim) {
    p.vx = (p.vx + (cx - p.x) * 0.01) * 0.8;
    p.vy = (p.vy + (cy - p.y) * 0.01) * 0.8;
    p.x = Math.max(pad, Math.min(width - pad, p.x + p.vx));
    p.y = Math.max(pad, Math.min(height - pad, p.y + p.vy));
  }
}

function readableHubLayout(
  nodes: Array<{ anchor: string }>,
  center: string,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const cx = width / 2;
  const cy = height / 2;
  result.set(center, { x: cx, y: cy });

  const outer = nodes.filter((node) => node.anchor !== center);
  const left: Array<{ anchor: string }> = [];
  const right: Array<{ anchor: string }> = [];
  for (let i = 0; i < outer.length; i++) {
    (i % 2 === 0 ? left : right).push(outer[i]);
  }

  assignColumnGroup(result, left, leftColumnXs(width), height);
  assignColumnGroup(result, right, rightColumnXs(width), height);
  return result;
}

const MIN_DENSE_ROW_GAP = 48;
const DENSE_VERTICAL_PAD = 40;
const DENSE_LANES_PER_SIDE = 1;

export function usesReadableHubLayout(
  nodes: Array<{ anchor: string }>,
  edges: Array<{ from: string; to: string }>,
  center: string | undefined,
): boolean {
  if (!center || nodes.length <= 10) return false;
  const outerAnchors = new Set(nodes.filter((node) => node.anchor !== center).map((node) => node.anchor));
  if (outerAnchors.size === 0) return false;

  const centerNeighbors = new Set<string>();
  for (const edge of edges) {
    if (edge.from === center && outerAnchors.has(edge.to)) centerNeighbors.add(edge.to);
    if (edge.to === center && outerAnchors.has(edge.from)) centerNeighbors.add(edge.from);
  }

  const minimumHubDegree = Math.min(8, Math.ceil(outerAnchors.size * 0.6));
  return centerNeighbors.size >= minimumHubDegree && centerNeighbors.size / outerAnchors.size >= 0.6;
}

export function readableHubLayoutHeight(nodeCount: number, baseHeight: number): number {
  if (nodeCount <= 10) return baseHeight;
  const outerCount = Math.max(0, nodeCount - 1);
  const maxSideCount = Math.ceil(outerCount / 2);
  const rowsPerSide = Math.max(1, Math.ceil(maxSideCount / DENSE_LANES_PER_SIDE));
  const requiredHeight = DENSE_VERTICAL_PAD * 2 + (rowsPerSide - 1) * MIN_DENSE_ROW_GAP;
  return Math.max(baseHeight, requiredHeight);
}

function leftColumnXs(width: number) {
  return [width * 0.2];
}

function rightColumnXs(width: number) {
  return [width * 0.8];
}

function assignColumnGroup(
  result: Map<string, { x: number; y: number }>,
  nodes: Array<{ anchor: string }>,
  xPositions: number[],
  height: number,
) {
  if (nodes.length === 0) return;
  const top = DENSE_VERTICAL_PAD;
  const bottom = height - DENSE_VERTICAL_PAD;
  const maxRows = Math.max(1, Math.floor((bottom - top) / MIN_DENSE_ROW_GAP) + 1);
  const laneCount = Math.min(xPositions.length, Math.ceil(nodes.length / maxRows));
  const laneSize = Math.ceil(nodes.length / laneCount);

  for (let lane = 0; lane < laneCount; lane++) {
    const start = lane * laneSize;
    const laneNodes = nodes.slice(start, start + laneSize);
    assignColumn(result, laneNodes, xPositions[lane], height);
  }
}

function assignColumn(
  result: Map<string, { x: number; y: number }>,
  nodes: Array<{ anchor: string }>,
  x: number,
  height: number,
) {
  if (nodes.length === 0) return;
  const top = DENSE_VERTICAL_PAD;
  const bottom = height - DENSE_VERTICAL_PAD;
  const step = nodes.length === 1 ? 0 : (bottom - top) / (nodes.length - 1);
  for (let i = 0; i < nodes.length; i++) {
    result.set(nodes[i].anchor, { x, y: nodes.length === 1 ? height / 2 : top + step * i });
  }
}
