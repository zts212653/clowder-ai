import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import {
  assessAntigravityCascadeHealth,
  cascadeHealthThresholdsFromEnv,
  DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-cascade-health.js';
import { decideAntigravityRecovery } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-recovery-policy.js';
import { collect, createMockBridge } from './antigravity-agent-service-test-helpers.js';

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

function baseRecoveryContext(overrides = {}) {
  return {
    errorCode: 'empty_response',
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

describe('F201 Phase D cascade health', () => {
  test('classifies warn and retire thresholds with planner and side-effect diagnostics', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: 'last visible planner output' },
      },
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: { operation: 'write', path: 'docs/example.md' },
      },
    ];
    while (steps.length < DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.retireSteps) {
      steps.push({ type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' });
    }

    const health = assessAntigravityCascadeHealth({
      cascadeId: 'cascade-retired',
      checkedAt: 1770000000000,
      trajectory: {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: steps.length,
        trajectory: { steps },
      },
    });

    assert.equal(health.level, 'retire');
    assert.equal(health.stepCount, DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.retireSteps);
    assert.ok(health.approximateTrajectoryBytes > 0);
    assert.deepEqual(health.reasons, ['step_count_retire_threshold']);
    assert.equal(health.retryableForEmptyResponse, false);
    assert.deepEqual(health.lastPlannerOutput, {
      stepIndex: 0,
      status: 'CORTEX_STEP_STATUS_DONE',
      text: 'last visible planner output',
    });
    assert.equal(health.lastSideEffectAt, 1770000000000);
  });

  test('supports env-tunable thresholds with invalid values falling back to defaults', () => {
    const thresholds = cascadeHealthThresholdsFromEnv({
      ANTIGRAVITY_CASCADE_WARN_STEPS: '3',
      ANTIGRAVITY_CASCADE_RETIRE_STEPS: '4',
      ANTIGRAVITY_CASCADE_WARN_BYTES: 'bad',
      ANTIGRAVITY_CASCADE_RETIRE_BYTES: '4096',
    });

    assert.equal(thresholds.warnSteps, 3);
    assert.equal(thresholds.retireSteps, 4);
    assert.equal(thresholds.warnBytes, DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS.warnBytes);
    assert.equal(thresholds.retireBytes, 4096);
  });

  test('allows empty_response fresh-cascade retry only when clean journal and cascade health is retryable', () => {
    const decision = decideAntigravityRecovery(
      baseRecoveryContext({
        cascadeHealth: {
          level: 'retire',
          retryableForEmptyResponse: true,
          reasons: ['step_count_retire_threshold'],
        },
      }),
    );

    assert.deepEqual(decision, {
      action: 'retry_fresh_cascade',
      reason: 'empty_response_retryable_cascade_health',
      delayMs: 0,
    });
  });

  test('AntigravityAgentService retires oversized cascade before sending the next user turn', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-old', 'cascade-fresh'][sessionIndex++];
    bridge.getCascadeHealth = async (cascadeId) => ({
      cascadeId,
      checkedAt: 1770000000000,
      level: cascadeId === 'cascade-old' ? 'retire' : 'ok',
      stepCount: cascadeId === 'cascade-old' ? 250 : 1,
      approximateTrajectoryBytes: cascadeId === 'cascade-old' ? 3_000_000 : 128,
      thresholds: DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS,
      reasons: cascadeId === 'cascade-old' ? ['step_count_retire_threshold'] : [],
      retryableForEmptyResponse: cascadeId === 'cascade-old',
    });
    bridge.pollForSteps = async function* (cascadeId) {
      assert.equal(cascadeId, 'cascade-fresh');
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { response: 'Fresh preflight cascade.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    assert.deepEqual(
      messages.filter((m) => m.type === 'text').map((m) => m.content),
      ['Fresh preflight cascade.'],
    );
    const marker = messages.find((m) => m.type === 'system_info' && m.content?.includes('cascade_health'));
    assert.ok(marker, 'preflight retire should emit a silent system_info marker');
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    assert.equal(bridge.sendMessage.mock.calls[0].arguments[0], 'cascade-fresh');
    assert.equal(bridge.resetSession.mock.callCount(), 1, 'should retire the oversized cascade before send');
  });

  test('AntigravityAgentService does not preflight-retire cascade with side-effect history', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-old', 'cascade-fresh'][sessionIndex++];
    bridge.getCascadeHealth = async (cascadeId) => ({
      cascadeId,
      checkedAt: 1770000000000,
      level: 'retire',
      stepCount: 250,
      approximateTrajectoryBytes: 3_000_000,
      thresholds: DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS,
      reasons: ['step_count_retire_threshold'],
      retryableForEmptyResponse: false,
      lastSideEffectAt: 1769999999000,
    });
    bridge.pollForSteps = async function* (cascadeId) {
      assert.equal(cascadeId, 'cascade-old');
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { response: 'Stayed on side-effect-bearing cascade.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    assert.deepEqual(
      messages.filter((m) => m.type === 'text').map((m) => m.content),
      ['Stayed on side-effect-bearing cascade.'],
    );
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'side-effect history must block preflight retire');
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    assert.equal(bridge.sendMessage.mock.calls[0].arguments[0], 'cascade-old');
  });

  test('AntigravityAgentService retries empty_response once when retired cascade has clean journal', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    let healthCall = 0;
    bridge.getOrCreateSession = async () => ['cascade-old', 'cascade-fresh'][sessionIndex++];
    bridge.getCascadeHealth = async (cascadeId) => {
      healthCall += 1;
      const retiredEmptyResponse = cascadeId === 'cascade-old' && healthCall > 1;
      return {
        cascadeId,
        checkedAt: 1770000000000,
        level: retiredEmptyResponse ? 'retire' : 'ok',
        stepCount: retiredEmptyResponse ? 250 : 1,
        approximateTrajectoryBytes: retiredEmptyResponse ? 3_000_000 : 128,
        thresholds: DEFAULT_ANTIGRAVITY_CASCADE_HEALTH_THRESHOLDS,
        reasons: retiredEmptyResponse ? ['step_count_retire_threshold'] : [],
        retryableForEmptyResponse: retiredEmptyResponse,
      };
    };
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-old') {
        yield {
          steps: [{ type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' }],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { response: 'Recovered on fresh cascade.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    assert.deepEqual(
      messages.filter((m) => m.type === 'text').map((m) => m.content),
      ['Recovered on fresh cascade.'],
    );
    assert.equal(
      messages.filter((m) => m.type === 'error' && m.errorCode === 'empty_response').length,
      0,
      'retryable retired cascade must not surface the first empty_response',
    );
    assert.equal(bridge.resetSession.mock.callCount(), 1, 'should retire old cascade before retry');
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'should resend prompt after cascade-health retry');
  });
});
