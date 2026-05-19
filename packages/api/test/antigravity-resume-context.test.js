import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAntigravityResumeContext } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-resume-context.js';

describe('F201 Antigravity resume context', () => {
  test('splits completed and pending effects for a user-approved resume turn', () => {
    const context = buildAntigravityResumeContext({
      cascadeId: 'cascade-1',
      interruptedAt: 1770000000500,
      journalSummary: {
        entries: [
          {
            threadId: 'thread-1',
            catId: 'antig-opus',
            cascadeId: 'cascade-1',
            stepIndex: 1,
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
          {
            threadId: 'thread-1',
            catId: 'antig-opus',
            cascadeId: 'cascade-1',
            stepIndex: 2,
            stepType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            effectKind: 'side_effect_pending',
            effectType: 'shell',
            operation: 'run_command',
            target: 'touch tmp/example',
            status: 'pending',
            retrySafe: false,
            idempotencyKey: 'pending:shell:run_command:def456',
            observedAt: 1770000000100,
          },
        ],
        hasSideEffect: true,
        hasUnsafeSideEffect: true,
        hasCompletedSideEffect: true,
        hasFailedSideEffect: false,
        hasPendingOrUnknownSideEffect: true,
        blocksBlindRetry: true,
        dedupedEntryCount: 0,
        retrySafeSummary: {
          safeToRetry: false,
          reason: 'unsafe_side_effect_seen',
          completedCount: 1,
          pendingOrUnknownCount: 1,
          failedCount: 0,
        },
      },
    });

    assert.equal(context.instruction, 'continue_without_repeating_completed_side_effects');
    assert.equal(context.completedEffects.length, 1);
    assert.equal(context.completedEffects[0].idempotencyKey, 'done:code:write:abc123');
    assert.equal(context.pendingOrUnknownEffects.length, 1);
    assert.equal(context.pendingOrUnknownEffects[0].idempotencyKey, 'pending:shell:run_command:def456');
  });

  test('carries resume tier decision without recomputing side-effect state', () => {
    const resumeTierDecision = {
      tier: 'tier3_manual_shared_or_external',
      canAutoResume: false,
      recoveryStrategy: 'manual_card',
      reason: 'shared_or_external_side_effect_requires_manual_review',
    };

    const context = buildAntigravityResumeContext({
      cascadeId: 'cascade-1',
      interruptedAt: 1770000000500,
      resumeTierDecision,
      journalSummary: {
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
      },
    });

    assert.deepEqual(context.resumeTierDecision, resumeTierDecision);
  });
});
