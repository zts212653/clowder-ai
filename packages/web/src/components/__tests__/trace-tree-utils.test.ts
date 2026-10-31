import { describe, expect, it } from 'vitest';
import { buildForest, flattenForest, type TraceSpan } from '../trace-tree-utils';

function span(id: string, parentId?: string, startMs = 0): TraceSpan {
  return {
    traceId: 'trace-1',
    spanId: id,
    parentSpanId: parentId,
    name: id,
    durationMs: 10,
    status: { code: 0 },
    attributes: {},
    startTimeMs: startMs,
    endTimeMs: startMs + 10,
    events: [],
  };
}

describe('buildForest', () => {
  it('builds a normal parent/child tree unchanged', () => {
    const spans = [span('root', undefined, 0), span('child1', 'root', 1), span('child2', 'root', 2)];
    const forest = buildForest(spans);
    expect(forest).toHaveLength(1);
    expect(forest[0].span.spanId).toBe('root');
    expect(forest[0].depth).toBe(0);
    expect(forest[0].children).toHaveLength(2);
    expect(forest[0].children[0].span.spanId).toBe('child1');
    expect(forest[0].children[0].depth).toBe(1);
    expect(forest[0].children[1].span.spanId).toBe('child2');
  });

  it('treats parentSpanId === spanId as a root (no infinite recursion)', () => {
    const spans = [span('self-ref', 'self-ref', 0), span('child', 'self-ref', 1)];
    const forest = buildForest(spans);
    expect(forest).toHaveLength(1);
    expect(forest[0].span.spanId).toBe('self-ref');
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].span.spanId).toBe('child');
  });

  it('handles A -> B -> A cycle without stack overflow', () => {
    const spans = [span('A', 'B', 0), span('B', 'A', 1)];
    const forest = buildForest(spans);
    const flat = flattenForest(forest);
    const ids = flat.map((n) => n.span.spanId).sort();
    expect(ids).toEqual(['A', 'B']);
  });

  it('surfaces a pure closed cycle instead of dropping it', () => {
    const spans = [span('X', 'Y', 0), span('Y', 'Z', 1), span('Z', 'X', 2)];
    const forest = buildForest(spans);
    const flat = flattenForest(forest);
    expect(flat).toHaveLength(3);
    const ids = flat.map((n) => n.span.spanId).sort();
    expect(ids).toEqual(['X', 'Y', 'Z']);
  });

  it('returns empty for empty input', () => {
    expect(buildForest([])).toEqual([]);
  });
});

describe('flattenForest', () => {
  it('flattens in pre-order (parent before children)', () => {
    const spans = [span('root', undefined, 0), span('a', 'root', 1), span('b', 'root', 2)];
    const flat = flattenForest(buildForest(spans));
    expect(flat.map((n) => n.span.spanId)).toEqual(['root', 'a', 'b']);
  });
});
