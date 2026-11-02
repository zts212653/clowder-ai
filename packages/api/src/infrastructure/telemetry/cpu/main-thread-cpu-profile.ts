import type { Profiler } from 'node:inspector';
import { type CodeCoordinate, codeCoordinate } from './cpu-code-coordinate.js';

const MAX_NODES = 4096;
const MAX_SAMPLES = 10000;
type CallFrame = Profiler.ProfileNode['callFrame'];
type Category = 'api' | 'node' | 'external' | 'idle' | 'gc' | 'native';
interface SampledCoordinate extends CodeCoordinate {
  selfSamples: number;
  nativeSamples?: number;
}

/** Retain code coordinates and numeric counts only, never raw inspector frames or URLs. */
export function projectMainThreadCpuProfile(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.slice(0, MAX_NODES).map((node) => [node.id, node]));
  const callers = nativeApiCallers(nodes);
  const categories = { api: 0, node: 0, external: 0, idle: 0, gc: 0, native: 0 };
  const frames = new Map<string, SampledCoordinate>();
  const samples = (profile.samples ?? []).slice(0, MAX_SAMPLES);
  let nativeSamplesWithApiCaller = 0;
  let nativeSamplesWithoutApiCaller = 0;
  for (const id of samples) {
    const frame = nodes.get(id)?.callFrame;
    const coordinate = codeCoordinate(frame);
    const kind = category(frame, coordinate);
    categories[kind]++;
    if (kind === 'api' && coordinate) countFrame(frames, coordinate, 'selfSamples');
    if (kind !== 'native') continue;
    const caller = callers.resolve(id);
    if (!caller) {
      nativeSamplesWithoutApiCaller++;
      continue;
    }
    nativeSamplesWithApiCaller++;
    countFrame(frames, caller, 'nativeSamples');
  }
  return {
    profileElapsedMs: Math.max(0, (profile.endTime - profile.startTime) / 1000),
    sampleCount: profile.samples?.length ?? 0,
    retainedSamples: samples.length,
    omittedNodes: Math.max(0, profile.nodes.length - MAX_NODES),
    omittedSamples: Math.max(0, (profile.samples?.length ?? 0) - MAX_SAMPLES),
    omittedParentEdges: callers.omittedParentEdges,
    nativeSamplesWithApiCaller,
    nativeSamplesWithoutApiCaller,
    categories,
    topFrames: [...frames.values()]
      .sort((a, b) => b.selfSamples + (b.nativeSamples ?? 0) - a.selfSamples - (a.nativeSamples ?? 0))
      .slice(0, 12),
  };
}

function countFrame(
  frames: Map<string, SampledCoordinate>,
  coordinate: CodeCoordinate,
  field: 'selfSamples' | 'nativeSamples',
) {
  const key = `${coordinate.file}:${coordinate.line}:${coordinate.function}`;
  const entry = frames.get(key) ?? { ...coordinate, selfSamples: 0 };
  entry[field] = (entry[field] ?? 0) + 1;
  frames.set(key, entry);
}

/** Index only bounded edges; incomplete or invalid chains never manufacture a caller. */
function nativeApiCallers(nodes: Map<number, Profiler.ProfileNode>) {
  const parents = new Map<number, number | null>();
  let indexedEdges = 0;
  let omittedParentEdges = 0;
  for (const node of nodes.values()) {
    const children = node.children ?? [];
    const retained = Math.min(children.length, MAX_NODES - indexedEdges);
    omittedParentEdges += children.length - retained;
    for (let i = 0; i < retained; i++) {
      const child = children[i];
      const previous = parents.get(child);
      parents.set(child, previous === undefined || previous === node.id ? node.id : null);
    }
    indexedEdges += retained;
  }

  // null marks a visiting or invalid chain; undefined is a valid chain without an API location.
  const memo = new Map<number, CodeCoordinate | null | undefined>();
  function resolve(id: number): CodeCoordinate | undefined {
    if (omittedParentEdges) return;
    const path: number[] = [];
    let cursor: number | null | undefined = id;
    let caller: CodeCoordinate | null | undefined;
    while (cursor !== undefined && cursor !== null) {
      if (memo.has(cursor)) {
        caller = memo.get(cursor);
        break;
      }
      memo.set(cursor, null);
      path.push(cursor);
      cursor = parents.get(cursor);
    }
    if (cursor === null || caller === null) return;
    for (const ancestor of path.reverse()) {
      caller = codeCoordinate(nodes.get(ancestor)?.callFrame) ?? caller;
      memo.set(ancestor, caller);
    }
    return memo.get(id) ?? undefined;
  }
  return { resolve, omittedParentEdges };
}

function category(frame: CallFrame | undefined, coordinate: CodeCoordinate | undefined): Category {
  if (!frame) return 'external';
  if (frame.functionName === '(idle)') return 'idle';
  if (frame.functionName === '(garbage collector)') return 'gc';
  if (frame.url.startsWith('node:')) return 'node';
  if (coordinate) return 'api';
  return frame.url ? 'external' : 'native';
}
