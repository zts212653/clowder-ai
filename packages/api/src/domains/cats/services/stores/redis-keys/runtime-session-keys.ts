/**
 * Redis key patterns for RuntimeSessionStore.
 * F211 Phase A1: runtime-session metadata sidecar.
 *
 * Note: cat-cafe: prefix is auto-added by ioredis keyPrefix.
 * All keys here are bare (without prefix).
 */

import type {
  RuntimeSessionLifecycleState,
  RuntimeSessionMetadata,
  RuntimeSessionRuntime,
} from '../../runtime-session/RuntimeSessionMetadata.js';

export const RuntimeSessionKeys = {
  /** String JSON: RuntimeSessionMetadata sidecar by SessionRecord.id */
  detail: (sessionId: string) => `runtime-session:${sessionId}`,
  /** String: runtime + runtimeSessionId -> SessionRecord.id */
  byRuntime: (runtime: RuntimeSessionRuntime, runtimeSessionId: string) =>
    `runtime-session:runtime:${runtime}:${runtimeSessionId}`,
  /** String: runtime + threadId + catId -> active SessionRecord.id */
  byThreadCat: (runtime: RuntimeSessionRuntime, threadId: string, catId: RuntimeSessionMetadata['catId']) =>
    `runtime-session-active:${runtime}:${threadId}:${catId}`,
  /** Sorted Set: lifecycle state -> SessionRecord.id, score = lifecycle.lastObservedAt */
  byLifecycleState: (state: RuntimeSessionLifecycleState) => `runtime-session:lifecycle:${state}`,
};
