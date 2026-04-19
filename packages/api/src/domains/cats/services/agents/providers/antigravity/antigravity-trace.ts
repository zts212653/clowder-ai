import { createModuleLogger } from '../../../../../../infrastructure/logger.js';

export const traceLog = createModuleLogger('antigravity-trace');

export const TRACE_ENABLED = process.env.ANTIGRAVITY_TRACE_RAW === '1';

/** Max raw response chars to log (prevents log explosion on large trajectories) */
export const RAW_RESPONSE_CAP = 8192;

/** RPC methods worth tracing — only trajectory responses carry step data */
export const TRACED_METHODS = new Set(['GetCascadeTrajectory', 'GetCascadeTrajectorySteps']);

/**
 * Recursively summarize an object's shape, replacing long strings with `[string:N]`.
 * Preserves ALL keys including ones not in our TypeScript interfaces — this is the
 * whole point: reveal upstream fields we don't know about.
 */
export function summarizeStepShape(obj: unknown, maxStringLen = 100): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return obj.length > maxStringLen ? `[string:${obj.length}]` : obj;
  }
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => summarizeStepShape(item, maxStringLen));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = summarizeStepShape(v, maxStringLen);
  }
  return result;
}
