import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_LINEAGE_MIN_ZOOM,
  HISTORICAL_LINEAGE_NODE_SIZE,
  historicalLineageEdgeKey,
  historicalLineageEdgeRoutes,
  layoutExplorationLineage,
  layoutExplorationLineageV2,
  layoutHistoricalLineage,
  lineageDetailLevel,
  sparseLineageEdgeRoute,
} from '../exploration/exploration-lineage';
import { DEFAULT_EXPLORATION, explorationReadingSchema } from '../exploration/exploration-reading';
import { lineageLabels } from '../exploration/lineage-labels';
import { fitLineageViewport } from '../exploration/lineage-viewport';

const ref = (id: string) => ({ ownerFeatureId: 'example-owner', ownerStateRef: id, version: 'v1' });
const node = (id: string, parents: string[] = []): EvolutionExplorationNodeV1 => ({
  kind: 'public_archive',
  nodeRef: ref(id),
  title: id,
  summary: `Summary ${id}`,
  sourceRef: ref(id),
  changes: [],
  parentEdges: parents.map((parent) => ({ parentNodeRef: ref(parent), sourceRef: ref(`${parent}:${id}`) })),
});

const cortex = (id: string): EvolutionExplorationNodeV1 => ({
  ...node(id),
  kind: 'public_archive',
  nodeRef: ref(`cortex-archive-container:${id}`),
  sourceRef: ref(`cortex-source:${id}`),
});

function segmentCrossesBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
  box: { left: number; top: number; right: number; bottom: number },
) {
  const steps = 80;
  return Array.from({ length: steps + 1 }, (_, index) => index / steps).some((ratio) => {
    const x = start.x + (end.x - start.x) * ratio;
    const y = start.y + (end.y - start.y) * ratio;
    return x > box.left && x < box.right && y > box.top && y < box.bottom;
  });
}

describe('readable lineage at different scales', () => {
  it('changes information density rather than shrinking all node text into unreadable cards', () => {
    expect(lineageDetailLevel(0.092)).toBe('points');
    expect(lineageDetailLevel(0.75)).toBe('compact');
    expect(lineageDetailLevel(1.3)).toBe('detail');
  });
  it('keeps both parents and all identities when the reader chooses a vertical layout', () => {
    const nodes = [node('root'), node('a', ['root']), node('b', ['root']), node('merge', ['a', 'b'])];
    const map = layoutExplorationLineage(nodes, []);
    const vertical = layoutExplorationLineage(nodes, [], 'vertical');
    expect(vertical.nodes.map((n) => n.key)).toEqual(map.nodes.map((n) => n.key));
    expect(vertical.nodes.at(-1)?.node.parentEdges).toHaveLength(2);
    expect(vertical.nodes[1].y).toBeGreaterThan(vertical.nodes[0].y);
    expect(vertical.nodes[1].x).not.toBe(vertical.nodes[2].x);
  });
  it('places authored history from left to right without manufacturing or dropping source relationships', () => {
    const historical = (id: string, index: number, parents: string[] = []): EvolutionExplorationNodeV1 => {
      const base = node(id, parents);
      if (base.kind !== 'public_archive') throw new Error('Expected a public archive test node');
      return { ...base, history: { period: `10月${index + 1}日`, updatedThrough: '2026-10-19' } };
    };
    const nodes = [
      historical('step-1', 0),
      historical('step-2', 1, ['step-1']),
      historical('step-3', 2, ['step-1']),
      historical('step-4', 3, ['step-2', 'step-3']),
      historical('step-5', 4),
    ];

    const map = layoutHistoricalLineage(nodes, []);
    expect(map.nodes.map((entry) => entry.key)).toEqual(nodes.map((entry) => refIdentity(entry.nodeRef)));
    expect(map.nodes.map((entry) => entry.x)).toEqual([...map.nodes.map((entry) => entry.x)].sort((a, b) => a - b));
    expect(map.nodes[3]?.node.parentEdges).toHaveLength(2);
    expect(map.nodes[4]?.y).not.toBe(map.nodes[0]?.y);
  });
  it('keeps twelve historical cards readable and horizontally pannable when the host is narrower than the story', () => {
    const nodes = Array.from({ length: 12 }, (_, index) => {
      const id = `step-${index + 1}`;
      const base = node(id, index ? [`step-${index}`] : []);
      if (base.kind !== 'public_archive') throw new Error('Expected a public archive test node');
      return { ...base, history: { period: `10月${index + 1}日`, updatedThrough: '2026-10-19' } };
    });
    const map = layoutHistoricalLineage(nodes, []);
    const first = fitLineageViewport(
      map,
      { width: 880, height: 320 },
      {
        minimumZoom: HISTORICAL_LINEAGE_MIN_ZOOM,
        nodeSize: HISTORICAL_LINEAGE_NODE_SIZE,
        selectedKey: map.nodes[0]?.key,
      },
    );
    const last = fitLineageViewport(
      map,
      { width: 880, height: 320 },
      {
        minimumZoom: HISTORICAL_LINEAGE_MIN_ZOOM,
        nodeSize: HISTORICAL_LINEAGE_NODE_SIZE,
        selectedKey: map.nodes.at(-1)?.key,
      },
    );
    const minimumScreenGap = Math.min(
      ...map.nodes.slice(1).map((entry, index) => {
        const previous = map.nodes[index];
        if (!previous) throw new Error('Historical cards must keep their authored predecessor');
        return (entry.x - previous.x) * first.zoom - HISTORICAL_LINEAGE_NODE_SIZE.width;
      }),
    );

    expect(first.zoom).toBe(HISTORICAL_LINEAGE_MIN_ZOOM);
    expect(minimumScreenGap).toBeGreaterThanOrEqual(16);
    expect(first.x).toBeGreaterThan(last.x);
    expect(first.x).toBeGreaterThanOrEqual(0);
    expect(map.width * last.zoom + last.x).toBeLessThanOrEqual(892);
  });
  it('keeps the selected independent lane inside a short historical canvas', () => {
    const nodes = Array.from({ length: 3 }, (_, index) => {
      const base = node(`root-${index + 1}`);
      if (base.kind !== 'public_archive') throw new Error('Expected a public archive test node');
      return { ...base, history: { period: `10月${index + 1}日`, updatedThrough: '2026-10-19' } };
    });
    const map = layoutHistoricalLineage(nodes, []);
    const selected = map.nodes.at(-1);
    if (!selected) throw new Error('Expected a selected independent history root');
    const fitted = fitLineageViewport(
      map,
      { width: 390, height: 260 },
      {
        minimumZoom: HISTORICAL_LINEAGE_MIN_ZOOM,
        nodeSize: HISTORICAL_LINEAGE_NODE_SIZE,
        selectedKey: selected.key,
      },
    );
    const selectedCenter = (selected.y + HISTORICAL_LINEAGE_NODE_SIZE.height / 2) * fitted.zoom + fitted.y;

    expect(selectedCenter - HISTORICAL_LINEAGE_NODE_SIZE.height / 2).toBeGreaterThanOrEqual(0);
    expect(selectedCenter + HISTORICAL_LINEAGE_NODE_SIZE.height / 2).toBeLessThanOrEqual(260);
  });
  it.each([
    'map',
    'vertical',
  ] as const)('routes long authored edges around every unrelated step in the %s layout', (direction) => {
    const historical = (id: string, parents: string[] = []): EvolutionExplorationNodeV1 => {
      const base = node(id, parents);
      if (base.kind !== 'public_archive') throw new Error('Expected a public archive test node');
      return { ...base, history: { period: id, updatedThrough: '2026-10-19' } };
    };
    const map = layoutHistoricalLineage(
      [
        historical('step-1'),
        historical('step-2', ['step-1']),
        historical('step-3', ['step-1']),
        historical('step-4', ['step-2', 'step-3']),
        historical('step-5', ['step-1']),
      ],
      [],
      direction,
    );
    const routes = historicalLineageEdgeRoutes(map.nodes, direction);
    expect(routes.has(historicalLineageEdgeKey(refIdentity(ref('step-1')), refIdentity(ref('step-2'))))).toBe(false);
    expect(routes.has(historicalLineageEdgeKey(refIdentity(ref('step-1')), refIdentity(ref('step-3'))))).toBe(true);
    const route = routes.get(historicalLineageEdgeKey(refIdentity(ref('step-1')), refIdentity(ref('step-5'))));
    if (!route) throw new Error('long authored edge must have a collision-free route');
    const endpointKeys = new Set([refIdentity(ref('step-1')), refIdentity(ref('step-5'))]);
    const collisions = route.slice(1).flatMap((point, index) => {
      const start = route[index];
      if (!start) throw new Error('route segment must have a starting point');
      return map.nodes
        .filter((entry) => !endpointKeys.has(entry.key))
        .filter((entry) =>
          segmentCrossesBox(start, point, {
            left: entry.x,
            top: entry.y,
            right: entry.x + HISTORICAL_LINEAGE_NODE_SIZE.width,
            bottom: entry.y + HISTORICAL_LINEAGE_NODE_SIZE.height,
          }),
        )
        .map((entry) => entry.key);
    });
    expect(collisions).toEqual([]);
  });
  it('persists the chosen layout with the existing camera and draft', () => {
    const value = {
      ...DEFAULT_EXPLORATION,
      lineageLayout: 'vertical',
      draft: { text: 'preserve me', intent: 'explore' },
    };
    expect(explorationReadingSchema.safeParse(value).success).toBe(true);
  });
  it('labels every sparse node in overview and drops colliding labels before the selected label', () => {
    const nodes = [node('root'), node('a', ['root']), node('b', ['root']), node('merge', ['a', 'b'])];
    const map = layoutExplorationLineage(nodes, []);
    const selected = map.nodes[3].key;
    const view = { ...DEFAULT_EXPLORATION.viewport, zoom: 0.5, x: 40, y: 40 };
    expect(lineageLabels(map, view, { width: 600, height: 300 }, selected).size).toBe(4);
    const crowded = lineageLabels(map, { ...view, zoom: 0.01 }, { width: 600, height: 300 }, selected);
    expect(crowded.has(selected)).toBe(true);
    expect(crowded.size).toBeLessThan(4);
  });
  it('centres sparse generations across a wide tree instead of compressing every generation into one corner', () => {
    const nodes = Array.from({ length: 63 }, (_, i) => node(String(i), i ? [String(Math.floor((i - 1) / 2))] : []));
    const map = layoutExplorationLineage(nodes, []);
    const leaves = map.nodes.slice(31);
    const lastLeaf = leaves.at(-1);
    if (!lastLeaf) throw new Error('Expected a complete synthetic generation');
    expect(map.nodes[0].y).toBe((leaves[0].y + lastLeaf.y) / 2);
    expect(map.width / map.height).toBeGreaterThan(2);
    expect(new Set(map.nodes.map((entry) => `${entry.x}:${entry.y}`)).size).toBe(63);
  });

  it('puts registered ancestry, parentless archives, and Cortex in named non-overlapping canvas regions', () => {
    const nodes = [node('v0'), node('v1', ['v0']), node('v5'), node('v6'), cortex('matches')];
    const map = layoutExplorationLineageV2(nodes, [], 'map');

    expect(map.regions.map((region) => region.label)).toEqual([
      '公开归档 · 已登记派生',
      '公开归档 · 父版未登记',
      'Cortex · 比赛归档',
    ]);
    const [registered, parentless, matches] = map.regions;
    expect(registered.nodeKeys).toHaveLength(2);
    expect(parentless.nodeKeys).toHaveLength(2);
    expect(matches.nodeKeys).toHaveLength(1);
    for (const [earlier, later] of [
      [registered, parentless],
      [parentless, matches],
    ] as const) {
      expect(earlier.top + earlier.height).toBeLessThan(later.top);
    }
  });

  it('routes sparse parent edges from the left ports below right-side labels', () => {
    const parent = { x: 24, y: 48 };
    const child = { x: 232, y: 48 };
    const zoom = 0.4;
    const route = sparseLineageEdgeRoute(parent, child, zoom);
    const label = {
      left: parent.x + 88 + 18 / zoom,
      top: parent.y + 56 - 9 / zoom,
      right: parent.x + 88 + 18 / zoom + 26 / zoom,
      bottom: parent.y + 56 + 9 / zoom,
    };

    expect(route[1]?.x).toBeLessThan(parent.x + 88);
    expect(route.at(-2)?.x).toBeLessThan(child.x + 88);
    expect(
      route.slice(1).some((point, index) => {
        const start = route[index];
        return start ? segmentCrossesBox(start, point, label) : false;
      }),
    ).toBe(false);
  });
});
