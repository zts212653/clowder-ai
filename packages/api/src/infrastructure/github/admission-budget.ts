import type { GateCtx } from '../scheduler/types.js';
import { KILL_GRACE_MS } from './gh-process.js';

// An aborted request still owns its process through TERM→KILL cleanup. Leave
// that canonical grace plus 500ms to return already collected facts.
const SETTLE_MS = KILL_GRACE_MS + 500;

/** Reserve room to return already collected durable work before the whole-gate
 * deadline. A slow remote object may fail independently of other ready items. */
export function gitHubAdmissionCanContinue(ctx: GateCtx | undefined): boolean {
  return ctx?.deadlineMs === undefined || Date.now() + SETTLE_MS < ctx.deadlineMs;
}

export function gitHubObjectSignal(ctx: GateCtx | undefined, maxDurationMs = 10_000): AbortSignal | undefined {
  if (!ctx?.signal) return undefined;
  const remaining = ctx.deadlineMs === undefined ? maxDurationMs : Math.max(1, ctx.deadlineMs - Date.now() - SETTLE_MS);
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(maxDurationMs, remaining))]);
}
