import type { Profiler } from 'node:inspector';

const API_ROOT = new URL('../', import.meta.url).href;
const MAX_NODES = 4096;
const MAX_SAMPLES = 10000;
type CallFrame = Profiler.ProfileNode['callFrame'];
type Category = 'api' | 'node' | 'external' | 'idle' | 'gc' | 'native';
interface CodeCoordinate {
  file: string;
  function: string;
  line: number;
}

/** Retain code coordinates and numeric counts only, never raw inspector frames or URLs. */
export function projectMainThreadCpuProfile(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.slice(0, MAX_NODES).map((node) => [node.id, node.callFrame]));
  const categories = { api: 0, node: 0, external: 0, idle: 0, gc: 0, native: 0 };
  const frames = new Map<string, CodeCoordinate & { selfSamples: number }>();
  const samples = (profile.samples ?? []).slice(0, MAX_SAMPLES);
  for (const id of samples) {
    const frame = nodes.get(id);
    const coordinate = codeCoordinate(frame);
    const kind = category(frame, coordinate);
    categories[kind]++;
    if (kind !== 'api' || !coordinate) continue;
    const key = `${coordinate.file}:${coordinate.line}:${coordinate.function}`;
    const entry = frames.get(key) ?? { ...coordinate, selfSamples: 0 };
    entry.selfSamples++;
    frames.set(key, entry);
  }
  return {
    profileElapsedMs: Math.max(0, (profile.endTime - profile.startTime) / 1000),
    sampleCount: profile.samples?.length ?? 0,
    retainedSamples: samples.length,
    omittedNodes: Math.max(0, profile.nodes.length - MAX_NODES),
    omittedSamples: Math.max(0, (profile.samples?.length ?? 0) - MAX_SAMPLES),
    categories,
    topFrames: [...frames.values()].sort((a, b) => b.selfSamples - a.selfSamples).slice(0, 12),
  };
}

function category(frame: CallFrame | undefined, coordinate: CodeCoordinate | undefined): Category {
  if (!frame) return 'external';
  if (frame.functionName === '(idle)') return 'idle';
  if (frame.functionName === '(garbage collector)') return 'gc';
  if (frame.url.startsWith('node:')) return 'node';
  if (coordinate) return 'api';
  return frame.url ? 'external' : 'native';
}

function codeCoordinate(frame: CallFrame | undefined): CodeCoordinate | undefined {
  if (!frame?.url.startsWith(API_ROOT)) return;
  const file = frame.url.slice(API_ROOT.length);
  if (!/^[A-Za-z0-9_./-]{1,180}\.(?:js|ts)$/.test(file) || file.startsWith('/') || file.split('/').includes('..'))
    return;
  return {
    file,
    function: /^[A-Za-z_$][A-Za-z0-9_$ .<>:-]{0,79}$/.test(frame.functionName) ? frame.functionName : '<anonymous>',
    line: Number.isSafeInteger(frame.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber + 1 : 0,
  };
}
