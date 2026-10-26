import type { Profiler } from 'node:inspector';

const API_ROOT = new URL('../../../', import.meta.url).href;
export interface CodeCoordinate {
  file: string;
  function: string;
  line: number;
}

/** Shared allowlist for public CPU summaries; raw frame URLs never pass through. */
export function codeCoordinate(frame: Profiler.ProfileNode['callFrame'] | undefined): CodeCoordinate | undefined {
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
