import type { EvolutionExplorationNodeV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { layoutExplorationLineage, lineageDetailLevel } from '../exploration/exploration-lineage';
import { DEFAULT_EXPLORATION, explorationReadingSchema } from '../exploration/exploration-reading';
import { lineageLabels } from '../exploration/lineage-labels';

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
});
