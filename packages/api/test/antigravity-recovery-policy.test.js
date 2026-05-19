import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decideAntigravityRecovery } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-recovery-policy.js';

const emptyJournalSummary = {
  entries: [],
  hasSideEffect: false,
  hasUnsafeSideEffect: false,
  hasCompletedSideEffect: false,
  hasFailedSideEffect: false,
  hasPendingOrUnknownSideEffect: false,
  blocksBlindRetry: false,
  dedupedEntryCount: 0,
  retrySafeSummary: {
    safeToRetry: true,
    reason: 'no_side_effect',
    completedCount: 0,
    pendingOrUnknownCount: 0,
    failedCount: 0,
  },
};

const completedJournalSummary = {
  ...emptyJournalSummary,
  entries: [
    {
      threadId: 'thread-1',
      catId: 'antig-opus',
      cascadeId: 'cascade-1',
      stepIndex: 7,
      stepType: 'CORTEX_STEP_TYPE_CODE_ACTION',
      effectKind: 'side_effect_done',
      effectType: 'code',
      operation: 'write',
      target: 'docs/example.md',
      status: 'done',
      retrySafe: false,
      idempotencyKey: 'done:code:write:abc123',
      observedAt: 1770000000000,
    },
  ],
  hasSideEffect: true,
  hasUnsafeSideEffect: true,
  hasCompletedSideEffect: true,
  blocksBlindRetry: true,
  retrySafeSummary: {
    safeToRetry: false,
    reason: 'unsafe_side_effect_seen',
    completedCount: 1,
    pendingOrUnknownCount: 0,
    failedCount: 0,
  },
};

function baseContext(overrides = {}) {
  return {
    errorCode: 'model_capacity',
    journalSummary: emptyJournalSummary,
    retryBudget: { attemptsUsed: 0, delaysMs: [0] },
    dispatchState: {
      hasDispatchRelevantStep: false,
      hasResolvedToolishStep: false,
      hasNativeDispatch: false,
      hasAttemptToolActivity: false,
      hasBatchToolActivity: false,
      toolishRetryEligible: false,
      dispatchRelevantStepKind: 'none',
    },
    ...overrides,
  };
}

describe('F201 Antigravity recovery policy', () => {
  test('retries transient provider errors before any side effect', () => {
    const decision = decideAntigravityRecovery(baseContext());

    assert.deepEqual(decision, {
      action: 'retry_fresh_cascade',
      reason: 'pre_side_effect_transient',
      delayMs: 0,
    });
  });

  test('surfaces resumable error after completed side effects instead of blind retry', () => {
    const decision = decideAntigravityRecovery(
      baseContext({
        journalSummary: completedJournalSummary,
        dispatchState: {
          ...baseContext().dispatchState,
          hasDispatchRelevantStep: true,
          hasResolvedToolishStep: true,
          dispatchRelevantStepKind: 'side_effect',
        },
      }),
    );

    assert.equal(decision.action, 'surface_resumable_error');
    assert.equal(decision.reason, 'post_side_effect_interrupted');
    assert.equal(decision.journalSummary.entries.length, 1);
  });

  test('retries transient provider errors after read-only MCP tool activity', () => {
    const decision = decideAntigravityRecovery(
      baseContext({
        dispatchState: {
          ...baseContext().dispatchState,
          hasDispatchRelevantStep: true,
          hasResolvedToolishStep: true,
          hasAttemptToolActivity: true,
          hasBatchToolActivity: true,
          dispatchRelevantStepKind: 'tool_read_mcp',
          readOnlyToolActivityRetryEligible: true,
        },
      }),
    );

    assert.deepEqual(decision, {
      action: 'retry_fresh_cascade',
      reason: 'pre_side_effect_transient',
      delayMs: 0,
    });
  });

  test('empty_response remains terminal without retryable cascade health', () => {
    const decision = decideAntigravityRecovery(baseContext({ errorCode: 'empty_response' }));

    assert.deepEqual(decision, {
      action: 'surface_terminal_error',
      reason: 'empty_response_without_retryable_cascade_health',
    });
  });
});
