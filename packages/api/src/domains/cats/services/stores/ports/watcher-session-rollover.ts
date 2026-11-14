import {
  parseWatcherSessionState,
  type SessionRecord,
  type WatcherSessionState,
  type WatcherSurfaceRetirement,
} from '@cat-cafe/shared';

export interface WatcherRolloverInput {
  sessionId: string;
  expectedRevision: number;
  expectedCliSessionId: string | undefined;
  expectedNativeSessionBinding: SessionRecord['nativeSessionBinding'];
  retirementId: string;
}

export function assertWatcherRetirementTransition(
  prior: WatcherSurfaceRetirement | undefined,
  next: WatcherSurfaceRetirement,
): void {
  if (next.phase === 'retired') throw new Error('watcher retirement requires rollover');
  if (!prior) return;
  const identity = [
    'id',
    'wakeInvocationId',
    'sourceInvocationId',
    'sourceSequence',
    'oldSchemaHash',
    'nativeCliSessionId',
  ] as const;
  if (identity.some((field) => prior[field] !== next[field])) throw new Error('watcher retirement identity changed');
  if (next.probes < prior.probes) throw new Error('watcher retirement probes cannot reset');
}

/** Copy only durable reading progress. A new physical native must obtain its own pin and wake allowance. */
export function watcherSuccessorState(state: WatcherSessionState): WatcherSessionState {
  const { notes, afterSequence, consumedThrough, messageOffset, backfillAfter, rawSince, activationCut } = state;
  return parseWatcherSessionState({
    revision: 0,
    notes,
    afterSequence,
    ...(consumedThrough !== undefined ? { consumedThrough } : {}),
    ...(messageOffset !== undefined ? { messageOffset } : {}),
    ...(backfillAfter !== undefined ? { backfillAfter: structuredClone(backfillAfter) } : {}),
    ...(rawSince !== undefined ? { rawSince } : {}),
    ...(activationCut !== undefined ? { activationCut } : {}),
  });
}
