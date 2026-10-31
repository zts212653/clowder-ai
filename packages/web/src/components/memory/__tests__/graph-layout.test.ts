import { describe, expect, it } from 'vitest';
import { forceLayout } from '../graph-layout';

describe('graph layout', () => {
  function minimumGapWithinColumns(positions: Map<string, { x: number; y: number }>) {
    const byColumn = new Map<number, number[]>();
    for (const { x, y } of positions.values()) {
      const roundedX = Math.round(x);
      byColumn.set(roundedX, [...(byColumn.get(roundedX) ?? []), y]);
    }

    return Math.min(
      ...[...byColumn.values()]
        .filter((ys) => ys.length > 1)
        .flatMap((ys) => {
          const sorted = [...ys].sort((a, b) => a - b);
          return sorted.slice(1).map((y, i) => y - sorted[i]);
        }),
    );
  }

  function minimumHorizontalGapWithinRows(positions: Map<string, { x: number; y: number }>) {
    const byRow = new Map<number, number[]>();
    for (const { x, y } of positions.values()) {
      const roundedY = Math.round(y);
      byRow.set(roundedY, [...(byRow.get(roundedY) ?? []), x]);
    }

    return Math.min(
      ...[...byRow.values()]
        .filter((xs) => xs.length > 1)
        .flatMap((xs) => {
          const sorted = [...xs].sort((a, b) => a - b);
          return sorted.slice(1).map((x, i) => x - sorted[i]);
        }),
    );
  }

  it('uses readable columns for dense hub graphs', () => {
    const nodes = [{ anchor: 'F186' }, ...Array.from({ length: 22 }, (_, i) => ({ anchor: `node-${i}` }))];
    const edges = nodes.slice(1).map((node) => ({ from: 'F186', to: node.anchor }));

    const positions = forceLayout(nodes, edges, 'F186', 940, 620);
    const outer = nodes.slice(1).map((node) => positions.get(node.anchor));
    const left = outer.filter((pos) => pos && pos.x < 470);
    const right = outer.filter((pos) => pos && pos.x > 470);
    const minGap = (items: Array<{ x: number; y: number } | undefined>) => {
      const ys = items
        .filter((pos): pos is { x: number; y: number } => Boolean(pos))
        .map((pos) => pos.y)
        .sort((a, b) => a - b);
      return Math.min(...ys.slice(1).map((y, i) => y - ys[i]));
    };

    expect(positions.get('F186')).toEqual({ x: 470, y: 310 });
    expect(left).toHaveLength(11);
    expect(right).toHaveLength(11);
    expect(minGap(left)).toBeGreaterThan(45);
    expect(minGap(right)).toBeGreaterThan(45);
  });

  it('expands dense hub rows instead of adding overlapping same-side lanes', () => {
    const nodes = [{ anchor: 'F186' }, ...Array.from({ length: 26 }, (_, i) => ({ anchor: `node-${i}` }))];
    const edges = nodes.slice(1).map((node) => ({ from: 'F186', to: node.anchor }));

    const positions = forceLayout(nodes, edges, 'F186', 940, 620);
    const outerPositions = new Map([...positions].filter(([anchor]) => anchor !== 'F186'));
    const columnCount = new Set([...outerPositions.values()].map((pos) => Math.round(pos.x))).size;

    expect(columnCount).toBe(2);
    expect(minimumGapWithinColumns(outerPositions)).toBeGreaterThanOrEqual(48);
  });

  it('keeps minimum row gap for very high-degree hub graphs', () => {
    const nodes = [{ anchor: 'F186' }, ...Array.from({ length: 73 }, (_, i) => ({ anchor: `node-${i}` }))];
    const edges = nodes.slice(1).map((node) => ({ from: 'F186', to: node.anchor }));

    const positions = forceLayout(nodes, edges, 'F186', 940, 620);
    const outerPositions = new Map([...positions].filter(([anchor]) => anchor !== 'F186'));

    expect(minimumGapWithinColumns(outerPositions)).toBeGreaterThanOrEqual(48);
  });

  it('spaces same-row dense hub nodes far enough for rectangular cards', () => {
    const nodes = [{ anchor: 'F186' }, ...Array.from({ length: 73 }, (_, i) => ({ anchor: `node-${i}` }))];
    const edges = nodes.slice(1).map((node) => ({ from: 'F186', to: node.anchor }));

    const positions = forceLayout(nodes, edges, 'F186', 940, 620);

    expect(minimumHorizontalGapWithinRows(positions)).toBeGreaterThanOrEqual(220);
  });

  it('keeps centered sparse graphs out of dense hub layout', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ anchor: `node-${i}` }));
    const edges = nodes.slice(1).map((node, i) => ({ from: `node-${i}`, to: node.anchor }));
    const positions = forceLayout(nodes, edges, 'node-0', 940, 620);
    const columnCount = new Set([...positions.values()].map((pos) => Math.round(pos.x))).size;

    expect(columnCount).toBeGreaterThan(3);
  });
});
