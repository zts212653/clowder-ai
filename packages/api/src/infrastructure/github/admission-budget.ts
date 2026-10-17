import type { GateCtx } from '../scheduler/types.js';

/** Reserve room to return already collected durable work before the whole-gate
 * deadline. A slow remote object may fail independently of other ready items. */
export function gitHubAdmissionCanContinue(ctx: GateCtx | undefined): boolean {
  return ctx?.deadlineMs === undefined || Date.now() + 1000 < ctx.deadlineMs;
}

export function gitHubObjectSignal(ctx: GateCtx | undefined): AbortSignal | undefined {
  if (!ctx?.signal) return undefined;
  const remaining = ctx.deadlineMs === undefined ? 10_000 : Math.max(1, ctx.deadlineMs - Date.now() - 500);
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(10_000, remaining))]);
}

/** The scheduler lane GitHub collectors share. Their reads queue on one serialized credential
 * lane and their deadlines count queue time, so they take turns instead of interleaving. */
export const GITHUB_COLLECTION_LANE = 'github';
