import type { StoreReadOptions } from './StoreReadOptions.js';

/** Process-local observations only; no session, thread, key or content coordinates. */
export interface SessionIndexBuildObservation {
  id: string;
  phase: 'checking' | 'scan' | 'backfill' | 'ready' | 'failed' | 'aborted';
  scanBatches: number;
  chainKeys: number;
  scanMs?: number;
  backfillMs?: number;
}

export interface SessionChainReadStage {
  phase: 'index_wait' | 'chain_keys' | 'chain_members' | 'session_records';
  index?: {
    mode: 'started' | 'joined' | 'ready';
    /** Shared build progress is live while readers await that same build. */
    build?: SessionIndexBuildObservation;
  };
}

export interface SessionChainReadOptions extends StoreReadOptions {
  onReadStage?: (stage: SessionChainReadStage) => void;
}

export function observeSessionChainRead(
  options: SessionChainReadOptions | undefined,
  stage: SessionChainReadStage,
): void {
  try {
    options?.onReadStage?.(stage);
  } catch {
    // An observer cannot change canonical reads, failures or cancellation.
  }
}
