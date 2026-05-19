export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  durationMs: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  startTimeMs: number;
  endTimeMs: number;
  events: ReadonlyArray<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
}

export interface SpanNode {
  span: TraceSpan;
  children: SpanNode[];
  depth: number;
}

export function buildForest(spans: TraceSpan[]): SpanNode[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const childMap = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const span of spans) {
    if (span.parentSpanId && span.parentSpanId !== span.spanId && byId.has(span.parentSpanId)) {
      const arr = childMap.get(span.parentSpanId) ?? [];
      arr.push(span);
      childMap.set(span.parentSpanId, arr);
    } else {
      roots.push(span);
    }
  }
  const visited = new Set<string>();
  function build(s: TraceSpan, depth: number): SpanNode {
    visited.add(s.spanId);
    const children = (childMap.get(s.spanId) ?? [])
      .filter((c) => !visited.has(c.spanId))
      .sort((a, b) => a.startTimeMs - b.startTimeMs)
      .map((c) => build(c, depth + 1));
    return { span: s, children, depth };
  }
  const forest = roots.sort((a, b) => a.startTimeMs - b.startTimeMs).map((r) => build(r, 0));
  for (const span of spans) {
    if (!visited.has(span.spanId)) forest.push(build(span, 0));
  }
  return forest;
}

export function flattenForest(nodes: SpanNode[]): SpanNode[] {
  const result: SpanNode[] = [];
  function walk(node: SpanNode) {
    result.push(node);
    for (const child of node.children) walk(child);
  }
  for (const root of nodes) walk(root);
  return result;
}
