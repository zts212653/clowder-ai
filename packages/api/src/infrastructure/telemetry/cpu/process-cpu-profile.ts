import type { Profiler } from 'node:inspector';
import { type CodeCoordinate, codeCoordinate } from './cpu-code-coordinate.js';

export const PROCESS_PROFILE_LIMITS = { nodes: 65536, edges: 131072, samples: 100000 } as const;
export interface ProcessCpuFrame extends CodeCoordinate {
  selfSamples: number;
  nativeSamples: number;
  apiCallerSamples: number;
  inclusiveSamples: number;
}
const keyOf = (c: CodeCoordinate) => `${c.file}:${c.line}:${c.function}`;

/** Longer process capture, separate from the legacy short observer's budgets/shape. */
export function projectProcessCpuProfile(profile: Profiler.Profile) {
  const retained = profile.nodes.slice(0, PROCESS_PROFILE_LIMITS.nodes);
  const nodes = new Map(retained.map((n) => [n.id, n]));
  const frames = new Map<string, ProcessCpuFrame>();
  const frameFor = (c: CodeCoordinate) => {
    const key = keyOf(c);
    let frame = frames.get(key);
    if (!frame) {
      frame = { ...c, selfSamples: 0, nativeSamples: 0, apiCallerSamples: 0, inclusiveSamples: 0 };
      frames.set(key, frame);
    }
    return frame;
  };
  const samples = (profile.samples ?? []).slice(0, PROCESS_PROFILE_LIMITS.samples);
  const categories = { api: 0, node: 0, external: 0, idle: 0, gc: 0, native: 0 };
  const weights = new Map<number, number>();
  const nativeWeights = new Map<number, number>();
  for (const id of samples) {
    const f = nodes.get(id)?.callFrame;
    const c = codeCoordinate(f);
    const kind = !f
      ? 'external'
      : f.functionName === '(idle)'
        ? 'idle'
        : f.functionName === '(garbage collector)'
          ? 'gc'
          : c
            ? 'api'
            : f.url.startsWith('node:')
              ? 'node'
              : f.url
                ? 'external'
                : 'native';
    categories[kind]++;
    if (c && kind === 'api') frameFor(c).selfSamples++;
    if (kind === 'idle' || kind === 'gc') continue;
    weights.set(id, (weights.get(id) ?? 0) + 1);
    if (kind === 'native') nativeWeights.set(id, (nativeWeights.get(id) ?? 0) + 1);
  }
  const graph = parentForest(nodes);
  const incomplete =
    retained.length !== profile.nodes.length || nodes.size !== retained.length || graph.omittedEdges > 0;
  const callers = new Map<number, CodeCoordinate | undefined>();
  if (!incomplete) walkForest(nodes, graph.parents, weights, callers, frameFor);
  let samplesWithApiCaller = 0;
  let nativeSamplesWithApiCaller = 0;
  for (const [id, count] of weights) {
    const caller = callers.get(id);
    if (!caller) continue;
    samplesWithApiCaller += count;
    const native = nativeWeights.get(id) ?? 0;
    nativeSamplesWithApiCaller += native;
    const frame = frameFor(caller);
    frame.apiCallerSamples += count;
    frame.nativeSamples += native;
  }
  const nonIdleSamples = samples.length - categories.idle - categories.gc;
  return {
    profileElapsedMs: Math.max(0, (profile.endTime - profile.startTime) / 1000),
    sampleCount: profile.samples?.length ?? 0,
    retainedSamples: samples.length,
    omittedSamples: Math.max(0, (profile.samples?.length ?? 0) - samples.length),
    omittedNodes: Math.max(0, profile.nodes.length - retained.length),
    omittedParentEdges: graph.omittedEdges,
    invalidNodeIds: retained.length - nodes.size,
    samplesWithApiCaller,
    samplesWithoutApiCaller: nonIdleSamples - samplesWithApiCaller,
    nativeSamplesWithApiCaller,
    nativeSamplesWithoutApiCaller: categories.native - nativeSamplesWithApiCaller,
    categories,
    // Inclusive counts overlap across different ancestor coordinates; never sum as CPU time.
    topFrames: [...frames.values()]
      .sort(
        (a, b) =>
          b.inclusiveSamples - a.inclusiveSamples ||
          b.apiCallerSamples - a.apiCallerSamples ||
          b.selfSamples - a.selfSamples,
      )
      .slice(0, 24),
  };
}

function parentForest(nodes: Map<number, Profiler.ProfileNode>) {
  const parents = new Map<number, number | null>();
  let edges = 0;
  let omittedEdges = 0;
  for (const n of nodes.values()) {
    const children = n.children ?? [];
    const count = Math.min(children.length, PROCESS_PROFILE_LIMITS.edges - edges);
    omittedEdges += children.length - count;
    for (let i = 0; i < count; i++) {
      const child = children[i];
      const previous = parents.get(child);
      parents.set(child, previous === undefined || previous === n.id ? n.id : null);
    }
    edges += count;
  }
  return { parents, omittedEdges };
}

/** Iterative forest traversal: O(retained nodes + edges + samples), including deep recursion. */
function walkForest(
  nodes: Map<number, Profiler.ProfileNode>,
  parents: Map<number, number | null>,
  weights: Map<number, number>,
  callers: Map<number, CodeCoordinate | undefined>,
  frameFor: (c: CodeCoordinate) => ProcessCpuFrame,
) {
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (parent === null || !nodes.has(child)) continue;
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const activeCoordinates = new Map<string, number>();
  const totals = new Map<number, number>();
  type Visit = { id: number; exit?: boolean; caller?: CodeCoordinate };
  const stack: Visit[] = [...nodes.keys()].filter((id) => !parents.has(id)).map((id) => ({ id }));
  // Multi-parent/cyclic components and their descendants have no trusted root and remain unknown.
  while (stack.length) {
    const visit = stack.pop();
    if (!visit) break;
    const c = codeCoordinate(nodes.get(visit.id)?.callFrame);
    const key = c && keyOf(c);
    if (!visit.exit) {
      const caller = c ?? visit.caller;
      callers.set(visit.id, caller);
      if (key) activeCoordinates.set(key, (activeCoordinates.get(key) ?? 0) + 1);
      stack.push({ id: visit.id, exit: true });
      for (const child of children.get(visit.id) ?? []) stack.push({ id: child, caller });
    } else {
      let total = weights.get(visit.id) ?? 0;
      for (const child of children.get(visit.id) ?? []) total += totals.get(child) ?? 0;
      totals.set(visit.id, total);
      if (key && c) {
        const depth = activeCoordinates.get(key) ?? 0;
        // Only the outermost instance contributes: recursive coordinates count once per sample.
        if (depth === 1 && total) frameFor(c).inclusiveSamples += total;
        if (depth === 1) activeCoordinates.delete(key);
        else activeCoordinates.set(key, depth - 1);
      }
    }
  }
}
