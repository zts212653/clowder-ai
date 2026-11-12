import type { SessionRecord, WatcherSessionState } from '@cat-cafe/shared';
import type { WatcherCheckpointOwners } from '../watcher-checkpoint.js';

export const MIN_WATCHER_WINDOW_TOKENS = 128;
export const WATCHER_RECOVERY_TOOL_BUDGET_EXHAUSTED = 'watcher_context_recovery_tool_budget_exhausted';
export const WATCHER_RECOVERY_DEADLINE_EXCEEDED = 'watcher_context_recovery_deadline_exceeded';
const recoveryLimit = (reason: unknown) =>
  reason === WATCHER_RECOVERY_TOOL_BUDGET_EXHAUSTED || reason === WATCHER_RECOVERY_DEADLINE_EXCEEDED;
export const watcherBudgetFailure = (value: unknown): boolean => {
  const reason = String(value instanceof Error ? value.message : value);
  return reason.includes('watcher_context_budget_exceeded') || recoveryLimit(reason);
};
export type WatcherWindow = NonNullable<WatcherSessionState['attempt']>['window'];

export function nextWatcherWindowTokens(state: WatcherSessionState): number {
  const tokens =
    state.attempt?.window?.tokenBudget ?? (state.wakeInvocationId ? state.rawWindowTokens : undefined) ?? 2500;
  return state.attempt && watcherBudgetFailure(state.attempt.failure) && !recoveryLimit(state.attempt.failure)
    ? Math.max(MIN_WATCHER_WINDOW_TOKENS, Math.floor(tokens / 2))
    : tokens;
}

/** Called only after exact native idle proof and revert. Audit persists before the cursor CAS. */
export async function watcherBudgetRecovery(
  owners: WatcherCheckpointOwners,
  session: SessionRecord,
  state: WatcherSessionState,
  nextWindow: WatcherWindow,
): Promise<Partial<WatcherSessionState>> {
  const attempt = state.attempt!;
  const tokens = nextWindow?.tokenBudget ?? nextWatcherWindowTokens(state);
  const exhaustedRecovery = recoveryLimit(attempt.failure);
  if (!exhaustedRecovery && (attempt.window?.tokenBudget ?? 2500) > MIN_WATCHER_WINDOW_TOKENS) {
    return {
      rawWindowTokens: tokens,
      attempt: {
        ...attempt,
        window: nextWindow ?? attempt.window,
        phase: 'running',
        failure: undefined,
        nativeTurnId: undefined,
        retries: (attempt.retries ?? 0) + 1,
      },
    };
  }
  const execution = await owners.executions.get(attempt.invocationId);
  if (
    !execution ||
    execution.executionKind !== 'watcher' ||
    execution.userId !== session.userId ||
    execution.threadId !== session.threadId ||
    execution.catId !== session.catId ||
    execution.causal?.watcherSourceInvocationId !== attempt.sourceInvocationId
  )
    throw new Error('watcher_budget_skip_binding_mismatch');
  const window = attempt.window!;
  const messageIds = window.messageIds.length
    ? window.messageIds
    : window.blockedMessageId
      ? [window.blockedMessageId]
      : [];
  if (!messageIds.length) throw new Error('watcher_budget_skip_original_missing');
  const through = messageIds.at(-1)!;
  const source = await owners.executions.get(attempt.sourceInvocationId);
  const responseId = source?.responseSettlement?.kind === 'message' ? source.responseSettlement.messageId : undefined;
  const complete = window.complete !== false || through === responseId;
  await owners.transcript.appendDurableEvent(
    {
      sessionId: session.id,
      threadId: session.threadId,
      catId: session.catId,
      seq: session.seq,
      cliSessionId: session.cliSessionId,
    },
    {
      type: 'watcher_window_skipped',
      reason: exhaustedRecovery ? attempt.failure : 'watcher_context_budget_exceeded',
      sourceInvocationId: attempt.sourceInvocationId,
      messageIds,
      from: { messageId: state.consumedThrough, offset: state.messageOffset ?? 0 },
      through: { messageId: through, offset: 0 },
      skippedRemainderOfMessage: window.offset > 0,
      tokenBudget: window.tokenBudget ?? MIN_WATCHER_WINDOW_TOKENS,
    },
    attempt.invocationId,
  );
  return {
    rawWindowTokens: window.tokenBudget ?? MIN_WATCHER_WINDOW_TOKENS,
    skippedWindows: (state.skippedWindows ?? 0) + 1,
    consumedThrough: complete && window.resumeCursor ? window.resumeCursor.messageId : through,
    messageOffset: complete && window.resumeCursor ? window.resumeCursor.offset : 0,
    backfillAfter: complete ? undefined : window.resumeCursor,
    afterSequence: complete ? attempt.sourceSequence : state.afterSequence,
    attempt: complete ? { ...attempt, phase: 'finalize_pending', prunedAt: Date.now() } : undefined,
  };
}
