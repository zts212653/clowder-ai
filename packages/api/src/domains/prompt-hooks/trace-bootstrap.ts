/**
 * TraceBootstrap — F237 (Trace v0)
 *
 * Module-level singleton for InjectionTraceStore.
 * Bootstrapped once at server startup when Redis is available.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { InjectionTraceStore } from './InjectionTraceStore.js';

let _traceStore: InjectionTraceStore | null = null;

/** Bootstrap the trace store singleton. Call once at server startup. */
export function bootstrapTraceStore(redis: RedisClient): void {
  _traceStore = new InjectionTraceStore(redis);
}

/** Get the bootstrapped trace store (null if Redis unavailable). */
export function getTraceStore(): InjectionTraceStore | null {
  return _traceStore;
}
