/**
 * F194 Phase Z3 — Producer state-machine hardening.
 *
 * Defensive try/finally helper called from routes/messages.ts background async block.
 * If the routeExecution chain leaves the parent recordStore invocation in `running`
 * (e.g., generator hang, swallowed exception, never-reached terminal write), this helper
 * reads the chainDone signal and writes the right terminal status with CAS guard.
 *
 * Spec: F194 KD-22/KD-23 + 砚砚 R1 P1-3 (read-side 不擅自终态化, producer must own terminal).
 *
 * The chainDone signal comes from `RouteChainCompletionTracker` — an in-memory map kept
 * per process. routeExecution calls .start(parentId) at entry, .succeed(parentId) at clean
 * done, .fail(parentId) at error. finally calls ensureTerminalStatus which reads .has().
 *
 * Sources:
 *   - chainDone_succeeded: chainCompletion.has(parentId) === 'succeeded' → CAS update succeeded
 *   - chainDone_failed: chainCompletion.has(parentId) === 'failed' → CAS update failed(producer_chain_failed)
 *   - fallback_no_signal: missing or 'pending' → CAS update failed(producer_left_running_no_terminal)
 *     + warn log so monitors can flag missed completion signals
 *   - already_terminal: record already non-running OR missing → no write
 */

import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';

export type ChainCompletionState = 'pending' | 'succeeded' | 'failed';

export class RouteChainCompletionTracker {
  private map = new Map<string, ChainCompletionState>();

  start(parentInvocationId: string): void {
    this.map.set(parentInvocationId, 'pending');
  }

  succeed(parentInvocationId: string): void {
    this.map.set(parentInvocationId, 'succeeded');
  }

  fail(parentInvocationId: string): void {
    this.map.set(parentInvocationId, 'failed');
  }

  has(parentInvocationId: string): ChainCompletionState | undefined {
    return this.map.get(parentInvocationId);
  }

  release(parentInvocationId: string): void {
    this.map.delete(parentInvocationId);
  }
}

export type EnsureTerminalSource =
  | 'already_terminal'
  | 'chainDone_succeeded'
  | 'chainDone_failed'
  | 'fallback_no_signal';

export interface EnsureTerminalDeps {
  invocationRecordStore: Pick<IInvocationRecordStore, 'get' | 'update'>;
  chainCompletion: Pick<RouteChainCompletionTracker, 'has'>;
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export interface EnsureTerminalResult {
  /** True iff a CAS update actually wrote a new status. */
  written: boolean;
  /** Final observed status (or 'missing' if record absent). */
  finalStatus: string;
  source: EnsureTerminalSource;
}

export async function ensureTerminalStatus(
  parentInvocationId: string,
  deps: EnsureTerminalDeps,
  opts: { reqId?: string } = {},
): Promise<EnsureTerminalResult> {
  const before = await deps.invocationRecordStore.get(parentInvocationId);
  if (!before) {
    return { written: false, finalStatus: 'missing', source: 'already_terminal' };
  }
  if (before.status !== 'running') {
    return { written: false, finalStatus: before.status, source: 'already_terminal' };
  }

  const chainState = deps.chainCompletion.has(parentInvocationId);
  let targetStatus: 'succeeded' | 'failed';
  let error: string | undefined;
  let source: EnsureTerminalSource;

  if (chainState === 'succeeded') {
    targetStatus = 'succeeded';
    source = 'chainDone_succeeded';
  } else if (chainState === 'failed') {
    targetStatus = 'failed';
    error = 'producer_chain_failed';
    source = 'chainDone_failed';
  } else {
    // 'pending' or undefined — no chainDone signal. Fallback failed for safety.
    // Read-side helper Z2 won't 擅自 succeeded (砚砚 R1 P1-3); producer must surface this
    // via warn log so monitors can flag missed completion signals.
    targetStatus = 'failed';
    error = 'producer_left_running_no_terminal';
    source = 'fallback_no_signal';
    deps.log?.warn?.(
      {
        invocationId: parentInvocationId,
        ...(opts.reqId ? { reqId: opts.reqId } : {}),
        source,
        feature: 'F194',
      },
      'F194 Z3 fallback terminal write — chainDone signal missing',
    );
  }

  const updated = await deps.invocationRecordStore.update(parentInvocationId, {
    status: targetStatus,
    expectedStatus: 'running',
    ...(error ? { error } : {}),
  });

  if (updated) {
    deps.log?.info?.(
      {
        invocationId: parentInvocationId,
        ...(opts.reqId ? { reqId: opts.reqId } : {}),
        from: 'running',
        to: targetStatus,
        source,
        feature: 'F194',
      },
      'F194 Z3 terminal write',
    );
    return { written: true, finalStatus: targetStatus, source };
  }

  // CAS rejected — record changed status between get() and update(). Re-read to report.
  const after = await deps.invocationRecordStore.get(parentInvocationId);
  return {
    written: false,
    finalStatus: after?.status ?? 'unknown',
    source,
  };
}
