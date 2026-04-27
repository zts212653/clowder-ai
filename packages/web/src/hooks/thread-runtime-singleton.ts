/**
 * F173 Phase B: Process-singleton ledger instance.
 *
 * Per KD-3 (spec): runtime-only, NOT in zustand. The ledger lives at module
 * scope so all hooks/components share the same per-thread runtime state without
 * threading it through React props.
 *
 * Tests that need a fresh ledger should call `resetThreadRuntimeSingleton()`
 * in beforeEach to avoid cross-test pollution (mirrors the pattern used by
 * shared-replaced-invocations.ts:resetSharedReplacedInvocations).
 */

import { createThreadRuntimeLedger, type ThreadRuntimeLedger } from './thread-runtime-ledger';

let singleton: ThreadRuntimeLedger = createThreadRuntimeLedger();

export function getThreadRuntimeLedger(): ThreadRuntimeLedger {
  return singleton;
}

/** Test-only: reset the singleton (call from beforeEach). */
export function resetThreadRuntimeSingleton(): void {
  singleton = createThreadRuntimeLedger();
}
