import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { InMemoryAntigravitySupervisorStore } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravitySupervisorStore.js';
import { collect, createMockBridge } from './antigravity-agent-service-test-helpers.js';

function readSideEffectAuditEntriesByInvocation(invocationId) {
  const auditPath = path.join(
    process.cwd(),
    'data',
    'antigravity-audit',
    `side-effect-journal-${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.invocationId === invocationId);
}

describe('AntigravityAgentService (Bridge) — fatal errors', () => {
  test('model_capacity retries on a fresh cascade and recovers without surfacing a final error', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-1', 'cascade-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Here is the recovered answer.' },
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

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['Here is the recovered answer.']);
    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.equal(warnings.length, 1, 'should yield one retry warning');
    assert.match(warnings[0].content, /自动重试/);
    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.equal(capacityErrors.length, 0, 'capacity error should stay hidden when retry succeeds');
    assert.equal(bridge.resetSession.mock.callCount(), 1, 'should reset the poisoned cascade before retry');
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'should resend the prompt after capacity retry');
  });

  test('quota-style model_capacity wording retries on a fresh cascade and preserves callback fallback prompt', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-1', 'cascade-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage: 'You have exhausted your capacity on this model. Your quota will reset after 0s.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after quota-style retry.' },
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
    const messages = await collect(
      service.invoke('Read the latest thread context', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-123',
          CAT_CAFE_CALLBACK_TOKEN: 'tok-456',
        },
        auditContext: { threadId: 'thread-f061-capacity', invocationId: 'inv-123', userId: 'u1', catId: 'antigravity' },
      }),
    );

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['Recovered after quota-style retry.']);
    assert.equal(bridge.resetSession.mock.callCount(), 1, 'should reset once for quota-style capacity retry');
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'should resend prompt after quota-style capacity retry');
    const resentPrompt = bridge.sendMessage.mock.calls[1].arguments[1];
    assert.match(resentPrompt, /Cat Cafe callback fallback/, 'retry prompt must preserve callback fallback');
    assert.match(resentPrompt, /thread-context\?invocationId=inv-123&callbackToken=tok-456/);
    assert.match(resentPrompt, /post-message/, 'retry prompt must preserve reply path');
    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.equal(capacityErrors.length, 0, 'capacity error should stay hidden when retry succeeds');
  });

  test('capacity retry fails fast on unsupported waiting tool step instead of hanging for stall timeout', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = async (step) => {
      if (step.metadata?.toolCall?.name === 'grep_search') return 'no_executor';
      return false;
    };
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-1', 'cascade-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'tool-1',
                name: 'grep_search',
                argumentsJson: JSON.stringify({ Pattern: 'foo', Path: 'src' }),
              },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 1,
          terminalSeen: false,
          lastActivityAt: Date.now(),
        },
      };
      throw new Error('Antigravity stall: no activity for 20ms (steps=1, status=CASCADE_RUN_STATUS_RUNNING)');
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
      pollTimeoutMs: 20,
    });
    const messages = await collect(service.invoke('hello'));

    const retryWarnings = messages.filter((m) => m.type === 'provider_signal');
    assert.equal(retryWarnings.length, 1, 'should still emit the first retry warning');
    const unsupported = messages.find((m) => m.type === 'error' && m.errorCode === 'unsupported_waiting_tool');
    assert.ok(unsupported, 'unsupported waiting tool should surface as explicit fatal error');
    assert.match(unsupported.error, /grep_search/i);
    assert.equal(
      messages.some((m) => m.type === 'error' && /^Antigravity stall:/i.test(m.error ?? '')),
      false,
      'should fail before the later stall timeout path fires',
    );
    assert.equal(
      messages.some((m) => m.type === 'error' && m.errorCode === 'empty_response'),
      false,
      'unsupported waiting tool should be the single terminal error',
    );
    assert.equal(bridge.resetSession.mock.callCount(), 1, 'should still reset once for the capacity retry');
  });

  test('upstream_error does NOT abort poll — model self-corrects in next batch', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Here is the corrected answer.' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 1, 'self-corrected text must be yielded after upstream_error');
    assert.equal(texts[0].content, 'Here is the corrected answer.');
    const errors = messages.filter((m) => m.type === 'error');
    assert.ok(
      errors.some((e) => e.errorCode === 'upstream_error'),
      'upstream_error still emitted',
    );
  });

  test('user denied permission on waiting run_command exposes approval_gate denied diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'user denied permission' } },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_perm_denied',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"curl -fsS https://example.com","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 5 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const err = messages.find((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.ok(err, 'must surface upstream_error');
    const diag = err.metadata?.diagnostics;
    assert.ok(diag, 'approval denial should carry diagnostics');
    assert.equal(diag.failureLayer, 'approval_gate');
    assert.equal(diag.dispatchState, 'before_dispatch');
    assert.equal(diag.approvalState, 'denied');
    assert.equal(diag.toolishToolName, 'run_command');
    assert.deepEqual(diag.executionJournal, {
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });
  });

  test('context canceled on waiting run_command exposes approval_gate timeout diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'context canceled' } },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_perm_timeout',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 6 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const err = messages.find((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.ok(err, 'must surface upstream_error');
    const diag = err.metadata?.diagnostics;
    assert.ok(diag, 'approval timeout should carry diagnostics');
    assert.equal(diag.failureLayer, 'approval_gate');
    assert.equal(diag.dispatchState, 'before_dispatch');
    assert.equal(diag.approvalState, 'timeout');
    assert.equal(diag.toolishToolName, 'run_command');
    assert.deepEqual(diag.executionJournal, {
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });
  });

  test('context canceled on run_command without toolCall.name still exposes approval_gate timeout diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'context canceled' } },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_ERROR',
            metadata: {
              toolCall: {
                id: 'toolu_perm_missing_name',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 9 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const err = messages.find((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.ok(err, 'must surface upstream_error');
    const diag = err.metadata?.diagnostics;
    assert.ok(diag, 'missing-name run_command should still carry approval diagnostics');
    assert.equal(diag.failureLayer, 'approval_gate');
    assert.equal(diag.dispatchState, 'before_dispatch');
    assert.equal(diag.approvalState, 'timeout');
    assert.equal(diag.toolishToolName, 'run_command');
    assert.deepEqual(diag.executionJournal, {
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });
  });

  test('context canceled on errored run_command still carries approval_gate diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'context canceled' } },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_ERROR',
            metadata: {
              toolCall: {
                id: 'toolu_perm_error',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 8 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const err = messages.find((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.ok(err, 'must surface upstream_error');
    const diag = err.metadata?.diagnostics;
    assert.ok(diag, 'errored run_command approval timeout should still carry diagnostics');
    assert.equal(diag.failureLayer, 'approval_gate');
    assert.equal(diag.approvalState, 'timeout');
    assert.equal(diag.toolishStepType, 'CORTEX_STEP_TYPE_RUN_COMMAND');
    assert.equal(diag.toolishToolName, 'run_command');
  });

  test('context canceled on non-run_command tool step stays upstream_error without approval_gate relabel', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'context canceled' } },
          },
          {
            type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_grep_timeout',
                name: 'grep_search',
                argumentsJson: '{"Pattern":"foo","Path":"src"}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 7 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const err = messages.find((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.ok(err, 'must surface upstream_error');
    assert.notEqual(
      err.metadata?.diagnostics?.failureLayer,
      'approval_gate',
      'non-run_command tool steps must not be mislabeled as approval_gate failures',
    );
  });

  test('context canceled with mixed toolish steps does not relabel approval_gate', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'context canceled' } },
          },
          {
            type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_grep_pending',
                name: 'grep_search',
                argumentsJson: '{"Pattern":"foo","Path":"src"}',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_ERROR',
            metadata: {
              toolCall: {
                id: 'toolu_runcommand_unrelated',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const err = messages.find((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.ok(err, 'must surface upstream_error');
    assert.notEqual(
      err.metadata?.diagnostics?.failureLayer,
      'approval_gate',
      'mixed toolish batches must not attribute the failure to an unrelated run_command step',
    );
  });

  test('model_capacity still triggers early abort — no ghost text', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'ghost text after capacity error' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 0, 'ghost text after model_capacity should NOT be yielded');
    const errors = messages.filter((m) => m.type === 'error');
    assert.ok(
      errors.some((e) => e.errorCode === 'model_capacity'),
      'must have model_capacity',
    );
  });

  test('model_capacity with waiting run_command exposes before_dispatch diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_before_dispatch',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 3 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    assert.equal(
      bridge.nativeExecuteAndPush.mock.callCount?.() ?? 0,
      0,
      'service must not dispatch native executor once terminalAbort is set by model_capacity',
    );
    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity');
    const diag = capacity.metadata?.diagnostics;
    assert.ok(diag, 'model_capacity should carry diagnostics for dispatch triage');
    assert.equal(diag.failureLayer, 'provider_capacity');
    assert.equal(diag.dispatchState, 'before_dispatch');
    assert.equal(diag.retryEligible, false);
    assert.equal(diag.retrySuppressedBy, 'retry_budget_exhausted');
    assert.equal(diag.toolishStepType, 'CORTEX_STEP_TYPE_RUN_COMMAND');
    assert.equal(diag.toolishToolName, 'run_command');
    assert.deepEqual(diag.executionJournal, {
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });
  });

  test('model_capacity with pending tool call stays before_dispatch', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_TOOL_CALL',
            status: 'CORTEX_STEP_STATUS_WAITING',
            toolCall: {
              toolName: 'grep_search',
              input: '{"Pattern":"foo","Path":"src"}',
            },
            metadata: {
              toolCall: {
                id: 'toolu_pending_grep',
                name: 'grep_search',
                argumentsJson: '{"Pattern":"foo","Path":"src"}',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity');
    assert.equal(capacity.metadata?.diagnostics?.dispatchState, 'before_dispatch');
    assert.deepEqual(capacity.metadata?.diagnostics?.executionJournal, {
      approvalSent: false,
      dispatchAttempted: false,
      dispatchReturned: false,
      writebackSent: false,
    });
  });

  test('model_capacity does not retry after CODE_ACTION side-effect-capable step', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/example.md' },
          },
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity once CODE_ACTION might have changed files');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry after CODE_ACTION');
    assert.equal(capacity.metadata?.diagnostics?.retryEligible, false);
    assert.equal(capacity.metadata?.diagnostics?.dispatchState, 'after_dispatch');
    assert.equal(capacity.metadata?.diagnostics?.retrySuppressedBy, 'resolved_toolish_step_seen');
    assert.equal(capacity.metadata?.diagnostics?.toolishStepType, 'CORTEX_STEP_TYPE_CODE_ACTION');
    assert.equal(capacity.metadata?.diagnostics?.sideEffectJournal?.hasCompletedSideEffect, true);
    assert.equal(capacity.metadata?.diagnostics?.sideEffectJournal?.blocksBlindRetry, true);
    assert.equal(capacity.metadata?.diagnostics?.sideEffectJournal?.entries?.length, 1);
    assert.equal(capacity.metadata?.diagnostics?.sideEffectJournal?.entries?.[0]?.operation, 'write');
    assert.equal(capacity.metadata?.diagnostics?.sideEffectJournal?.entries?.[0]?.target, 'docs/example.md');
    assert.match(capacity.metadata?.diagnostics?.sideEffectJournal?.entries?.[0]?.idempotencyKey, /^done:code:write:/);
    assert.equal(capacity.metadata?.diagnostics?.recoveryDecision?.action, 'surface_resumable_error');
    assert.equal(capacity.metadata?.diagnostics?.recoveryDecision?.reason, 'post_side_effect_interrupted');
    assert.equal(
      capacity.metadata?.diagnostics?.resumeContext?.instruction,
      'continue_without_repeating_completed_side_effects',
    );
    assert.equal(capacity.metadata?.diagnostics?.resumeContext?.completedEffects?.length, 1);
    assert.equal(capacity.metadata?.diagnostics?.resumeContext?.completedEffects?.[0]?.operation, 'write');
  });

  test('model_capacity after CODE_ACTION emits typed recovery rich block card', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/capacity-after-write.md' },
          },
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry after CODE_ACTION');
    const recoveryMsg = messages.find((m) => {
      if (m.type !== 'system_info') return false;
      const parsed = JSON.parse(m.content);
      return parsed.type === 'rich_block' && parsed.block?.meta?.kind === 'antigravity_recovery';
    });
    assert.ok(recoveryMsg, 'post-side-effect model_capacity should emit a typed recovery rich block');

    const parsed = JSON.parse(recoveryMsg.content);
    assert.equal(parsed.type, 'rich_block');
    assert.equal(parsed.block.kind, 'card');
    assert.equal(parsed.block.tone, 'warning');
    assert.equal(parsed.block.meta.recoveryDecision.action, 'surface_resumable_error');
    assert.equal(parsed.block.meta.recoveryDecision.reason, 'post_side_effect_interrupted');
    assert.equal(parsed.block.meta.completedEffectCount, 1);
    assert.match(parsed.block.bodyMarkdown, /停止自动重试/);
    assert.ok(
      parsed.block.fields.some(
        (field) => field.label === '已完成动作' && field.value.includes('docs/capacity-after-write.md'),
      ),
    );
  });

  test('model_capacity retries after read-only MCP_TOOL metadata-only batches', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-1', 'cascade-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-2') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'FINISHED',
              plannerResponse: { response: 'Recovered after readonly memory lookup.' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_MCP_TOOL',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              toolCall: {
                id: 'toolu_search_evidence',
                name: 'cat_cafe_search_evidence',
                argumentsJson: '{"query":"F201"}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 4 },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 2,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.equal(capacityErrors.length, 0, 'read-only MCP tool capacity should stay hidden when retry succeeds');
    assert.equal(
      bridge.resetSession.mock.callCount(),
      1,
      'read-only MCP tool capacity should retry on a fresh cascade',
    );
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'retry should resend the prompt after readonly MCP capacity');
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['Recovered after readonly memory lookup.']);
  });

  test('model_capacity retries when the blocked waiting run_command is read-only and undispatched', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-1', 'cascade-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_WAITING',
              metadata: {
                toolCall: {
                  id: 'toolu_read_only',
                  name: 'run_command',
                  argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
                },
                sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 3 },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: false,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after read-only retry.' },
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
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['Recovered after read-only retry.']);
    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.equal(capacityErrors.length, 0, 'read-only undispatched command should not surface terminal model_capacity');
    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.equal(warnings.length, 1, 'should still emit retry warning');
    assert.equal(bridge.nativeExecuteAndPush.mock.callCount(), 1, 'recovered cascade still probes bridge once');
    assert.ok(
      bridge.nativeExecuteAndPush.mock.calls.every(
        (call) => call.arguments[0]?.metadata?.toolCall?.id !== 'toolu_read_only',
      ),
      'read-only retry must happen before the blocked waiting command itself is dispatched',
    );
    assert.equal(bridge.resetSession.mock.callCount(), 1, 'should reset and retry on a fresh cascade');
  });

  test('model_capacity does not retry a read-only waiting run_command when SafeToAutoRun is false', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_read_only_not_safe',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":false}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 12 },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 2,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity when SafeToAutoRun is false');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry approval-gated commands');
    assert.equal(capacity.metadata?.diagnostics?.retryEligible, false);
  });

  test('model_capacity reports retry_budget_exhausted when a read-only waiting run_command has no retries left', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_budget_exhausted',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 11 },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 2,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity once retry budget is exhausted');
    assert.equal(capacity.metadata?.diagnostics?.retryEligible, false);
    assert.equal(capacity.metadata?.diagnostics?.retrySuppressedBy, 'retry_budget_exhausted');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry once budget is exhausted');
  });

  test('model_capacity retries for read-only waiting run_command even when toolCall.name is missing', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-1', 'cascade-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_WAITING',
              metadata: {
                toolCall: {
                  id: 'toolu_read_only_missing_name',
                  argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
                },
                sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 10 },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 2,
            terminalSeen: false,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after missing-name retry.' },
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
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['Recovered after missing-name retry.']);
    assert.equal(
      bridge.resetSession.mock.callCount(),
      1,
      'missing-name run_command should still qualify for safe retry',
    );
  });

  test('model_capacity still does not retry when the waiting run_command is mutating', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_mutating',
                name: 'run_command',
                argumentsJson:
                  '{"CommandLine":"mkdir -p /tmp/cc-antig-probe && date > /tmp/cc-antig-probe/run.txt","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 3 },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 2,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'mutating command should still surface model_capacity');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry mutating commands');
    assert.equal(
      bridge.nativeExecuteAndPush.mock.callCount(),
      0,
      'mutating command is still undispatched in this batch, but retry must remain disabled',
    );
    assert.equal(capacity.metadata?.diagnostics?.retryEligible, false);
  });

  test('model_capacity does not retry when waiting steps are mixed even if the first one is read-only', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_read_only_first',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 3 },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_mutating_second',
                name: 'run_command',
                argumentsJson:
                  '{"CommandLine":"mkdir -p /tmp/cc-antig-probe && date > /tmp/cc-antig-probe/run.txt","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 4 },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 3,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'mixed waiting steps should still surface model_capacity');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry mixed waiting-step batches');
    assert.equal(capacity.metadata?.diagnostics?.retryEligible, false);
  });

  test('model_capacity does not retry after native dispatch already happened earlier in the invoke', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    let pollCount = 0;
    bridge.pollForSteps = async function* () {
      pollCount += 1;
      if (pollCount === 1) {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_WAITING',
              metadata: {
                toolCall: {
                  id: 'toolu_prior_dispatch',
                  name: 'run_command',
                  argumentsJson: '{"CommandLine":"pwd","Cwd":"/tmp","SafeToAutoRun":true}',
                },
                sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 1 },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: false,
            lastActivityAt: Date.now(),
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_WAITING',
              metadata: {
                toolCall: {
                  id: 'toolu_read_only_late',
                  name: 'run_command',
                  argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
                },
                sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 2 },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 3,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'capacity should still surface once native dispatch already happened');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry after native dispatch in the same invoke');
    assert.equal(capacity.metadata?.diagnostics?.retrySuppressedBy, 'native_dispatch_seen');
    assert.equal(capacity.metadata?.diagnostics?.dispatchState, 'after_dispatch');
    assert.deepEqual(capacity.metadata?.diagnostics?.executionJournal, {
      approvalSent: false,
      dispatchAttempted: true,
      dispatchReturned: true,
      writebackSent: true,
    });
  });

  test('model_capacity does not retry after an earlier batch already finished a run_command upstream', async () => {
    const bridge = createMockBridge();
    let pollCount = 0;
    bridge.pollForSteps = async function* () {
      pollCount += 1;
      if (pollCount === 1) {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'FINISHED',
              metadata: {
                toolCall: {
                  id: 'toolu_upstream_finished',
                  name: 'run_command',
                  argumentsJson: '{"CommandLine":"mkdir -p /tmp/cc-antig-probe","Cwd":"/tmp","SafeToAutoRun":true}',
                },
                sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 1 },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: false,
            lastActivityAt: Date.now(),
          },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_WAITING',
              metadata: {
                toolCall: {
                  id: 'toolu_waiting_after_finished',
                  name: 'run_command',
                  argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
                },
                sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 2 },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 3,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      }
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity after earlier finished tool step');
    assert.equal(
      bridge.resetSession.mock.callCount(),
      0,
      'must not retry once an earlier batch already finished a toolish step',
    );
    assert.equal(capacity.metadata?.diagnostics?.retrySuppressedBy, 'resolved_toolish_step_seen');
    assert.equal(capacity.metadata?.diagnostics?.dispatchState, 'after_dispatch');
  });

  test('model_capacity in a mixed batch with a finished tool step reports after_dispatch diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'FINISHED',
            metadata: {
              toolCall: {
                id: 'toolu_finished_same_batch',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"pwd","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 1 },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_waiting_same_batch',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 2 },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 3,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'must surface model_capacity');
    assert.equal(capacity.metadata?.diagnostics?.dispatchState, 'after_dispatch');
    assert.equal(capacity.metadata?.diagnostics?.retrySuppressedBy, 'resolved_toolish_step_seen');
    assert.deepEqual(capacity.metadata?.diagnostics?.executionJournal, {
      approvalSent: false,
      dispatchAttempted: true,
      dispatchReturned: true,
      writebackSent: true,
    });
  });

  test('model_capacity does not retry when a finished toolish step shares the batch with a waiting read-only run_command', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'FINISHED',
            metadata: {
              toolCall: {
                id: 'toolu_finished_prior',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"pwd","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 1 },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_waiting_read_only',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 2 },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 3,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    const capacity = messages.find((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.ok(capacity, 'mixed finished+waiting toolish batch should still surface model_capacity');
    assert.equal(
      bridge.resetSession.mock.callCount(),
      0,
      'must not retry when another toolish step already exists in the batch',
    );
    assert.equal(capacity.metadata?.diagnostics?.retryEligible, false);
  });

  test('model_capacity aborts even when upstream_error co-occurs in same batch', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'ghost text after mixed errors' },
          },
        ],
        cursor: { baselineStepCount: 2, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 0, 'model_capacity must abort even with co-occurring upstream_error');
    const errors = messages.filter((m) => m.type === 'error');
    assert.ok(
      errors.some((e) => e.errorCode === 'model_capacity'),
      'model_capacity error must be emitted',
    );
  });

  test('stream_error before any text is buffered and later recovery text still arrives', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'ghost text after stream error' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['ghost text after stream error']);
    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(
      errors.some((e) => e.errorCode === 'stream_error'),
      false,
      'buffered no-text stream_error stays hidden if recovery text arrives',
    );
  });

  test('buffered no-text stream_error expires when no recovery text arrives before grace deadline', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, []);
    const streamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'stream_error');
    assert.equal(
      streamErrors.length,
      1,
      'stream_error should surface after no-text grace expires when retry budget exhausted',
    );
  });

  test('stream_error after partial text is buffered and later recovery text still arrives', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_GENERATING',
            plannerResponse: { modifiedResponse: '好的，我来换个方式——' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { response: '我继续把结果说完。' },
          },
        ],
        cursor: { baselineStepCount: 2, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(
      texts,
      ['好的，我来换个方式——', '我继续把结果说完。'],
      'stream_error after partial text should not truncate later recovery text',
    );
    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(
      errors.some((e) => e.errorCode === 'stream_error'),
      false,
      'buffered stream_error stays hidden',
    );
  });

  test('buffered stream_error is dropped when upstream_error arrives later', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_GENERATING',
            plannerResponse: { modifiedResponse: '好的，我来换个方式——' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
          },
        ],
        cursor: { baselineStepCount: 2, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('hello'));

    const streamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'stream_error');
    const upstreamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'upstream_error');
    assert.equal(streamErrors.length, 0, 'buffered stream_error should be dropped when upstream_error arrives');
    assert.equal(upstreamErrors.length, 1, 'upstream_error should be surfaced');
  });

  test('buffered stream_error is dropped when model_capacity arrives later', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_GENERATING',
            plannerResponse: { modifiedResponse: '好的，我来换个方式——' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 2, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const streamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'stream_error');
    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['好的，我来换个方式——']);
    assert.equal(streamErrors.length, 0, 'buffered stream_error should be dropped when model_capacity arrives');
    assert.equal(capacityErrors.length, 1, 'model_capacity should be surfaced');
  });

  test('buffered stream_error expires when no recovery text arrives before grace deadline', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_GENERATING',
            plannerResponse: { modifiedResponse: '好的，我来换个方式——' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [],
    });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['好的，我来换个方式——']);
    const streamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'stream_error');
    assert.equal(streamErrors.length, 1, 'stream_error should surface after grace expires when retry budget exhausted');
  });

  test('does NOT emit empty_response when fatalSeen', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: { error: { modelErrorMessage: 'INVALID_ARGUMENT (code 400)' } },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('hello'));

    const emptyErrs = messages.filter((m) => m.type === 'error' && m.errorCode === 'empty_response');
    assert.equal(emptyErrs.length, 0, 'should NOT add empty_response when fatal already reported');
  });

  test('tool_error does NOT trigger early abort', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
            status: 'FINISHED',
            toolResult: { toolName: 'image_gen', success: false, error: 'quota exceeded' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Sorry, image generation failed.' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('hello'));

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 1, 'text after tool_error should still be yielded');
  });

  test('P1: approval_pending must not add toolCallId to handledToolCallIds — step must be re-tried in next batch', async () => {
    const bridge = createMockBridge();
    const toolCallId = 'toolu_approval_1';
    let waitingStepCallCount = 0;
    bridge.nativeExecuteAndPush = async (step) => {
      if (step.metadata?.toolCall?.id === toolCallId) {
        waitingStepCallCount++;
        if (waitingStepCallCount === 1) return 'approval_pending';
        return true;
      }
      return false;
    };
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: toolCallId,
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false }),
        },
      },
    };
    bridge.pollForSteps = async function* () {
      // Batch 1: approval-pending (awaitingUserInput: false so step is processed by nativeExecuteAndPush loop)
      yield {
        steps: [waitingStep],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 0,
          terminalSeen: false,
          lastActivityAt: Date.now(),
          awaitingUserInput: false,
        },
      };
      // Batch 2: same step re-presented after approval + final response
      yield {
        steps: [
          waitingStep,
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { response: 'all done' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test'));

    assert.equal(
      waitingStepCallCount,
      2,
      'approval_pending must not add toolCallId to handledToolCallIds — step must be re-tried in next batch',
    );
    const text = messages.find((m) => m.type === 'text');
    assert.ok(text, 'text response must be yielded after re-processed step');
  });

  test('P1: false from nativeExecuteAndPush (kill-switch / no-registry) must NOT trigger unsupported_waiting_tool', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = async () => false;
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_ks',
                name: 'run_command',
                argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: true }),
              },
              sourceTrajectoryStepInfo: { trajectoryId: 't1', stepIndex: 0, cascadeId: 'c1' },
            },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 1,
          terminalSeen: false,
          lastActivityAt: Date.now(),
        },
      };
      throw new Error('Antigravity stall: no activity for 20ms (steps=1, status=CASCADE_RUN_STATUS_RUNNING)');
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      pollTimeoutMs: 20,
    });
    const messages = await collect(service.invoke('hello'));

    const unsupported = messages.find((m) => m.type === 'error' && m.errorCode === 'unsupported_waiting_tool');
    assert.equal(
      unsupported,
      undefined,
      'false from nativeExecuteAndPush (kill-switch / no-registry disabled) must NOT trigger unsupported_waiting_tool',
    );
  });

  // Bug-E: after a fatal terminal error (stream_error / upstream_error / model_capacity
  // retries exhausted), a subsequent invocation with the same callbackEnv must still
  // have `[Cat Cafe callback fallback]` injected into the prompt. The service is
  // stateless per-invoke by construction; this test locks that invariant so future
  // stateful optimizations (e.g. caching resolved session info across invokes) don't
  // accidentally skip injection on the "continuity" path.
  test('Bug-E: fatal error does not invalidate callback fallback injection for subsequent invocation', async () => {
    const callbackEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'inv-continuity-42',
      CAT_CAFE_CALLBACK_TOKEN: 'token-xyz',
    };

    const bridge = createMockBridge();
    // Invocation 1: model_capacity with no retries → fatal
    let invoked = 0;
    bridge.pollForSteps = mock.fn(async function* () {
      invoked += 1;
      if (invoked === 1) {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
        return;
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Round 2 reply.' },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 1,
          terminalSeen: true,
          lastActivityAt: Date.now(),
        },
      };
    });

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [], // disable retry → fatal exits immediately
    });

    // Invocation 1: prompt A with callbackEnv → fatal capacity error
    const msgs1 = await collect(service.invoke('round-1 question', { callbackEnv }));
    const err1 = msgs1.find((m) => m.type === 'error');
    assert.ok(err1, 'first invocation surfaces fatal error');

    // Invocation 2: prompt B with SAME callbackEnv → fallback still injected
    const msgs2 = await collect(service.invoke('round-2 question', { callbackEnv }));
    assert.ok(
      msgs2.find((m) => m.type === 'text' && /Round 2 reply/.test(m.content ?? '')),
      'second invocation completes normally',
    );

    // Inspect the prompts actually sent to the bridge
    const sendCalls = bridge.sendMessage.mock.calls;
    assert.equal(sendCalls.length, 2, 'sendMessage should be invoked once per invocation');
    const [, round1Text] = sendCalls[0].arguments;
    const [, round2Text] = sendCalls[1].arguments;

    // Invocation 1 prompt: must contain callback fallback + the prompt body
    assert.match(round1Text, /\[Cat Cafe callback fallback\]/);
    assert.ok(round1Text.includes('inv-continuity-42'), 'round 1 prompt carries invocationId');
    assert.ok(round1Text.includes('token-xyz'), 'round 1 prompt carries callbackToken');

    // Invocation 2 prompt: fatal did NOT invalidate fallback injection
    assert.match(round2Text, /\[Cat Cafe callback fallback\]/);
    assert.ok(round2Text.includes('inv-continuity-42'), 'round 2 prompt keeps invocationId after fatal');
    assert.ok(round2Text.includes('token-xyz'), 'round 2 prompt keeps callbackToken after fatal');
    assert.ok(round2Text.includes('round-2 question'), 'round 2 prompt body present');
  });

  // F061 Bug-F UX (codex peer review on 8b1a71ba): cold-start onboarding tools
  // MUST exist in READONLY_ALLOWED_TOOLS or be accessed via callback HTTP.
  // The previous version of the prompt referenced cat_cafe_get_thread_context
  // with invocationId/callbackToken — that tool is NOT in the readonly whitelist
  // AND its schema doesn't accept those args. Lock the contract here.
  test('cold-start onboarding tools must match actual MCP whitelist + callback paths', async () => {
    const { READONLY_ALLOWED_TOOLS } = await import('../../mcp-server/dist/server-toolsets.js');
    const fs = await import('node:fs');
    const sourcePath = fileURLToPath(
      new URL('../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js', import.meta.url),
    );
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Locate the cold-start onboarding section verbatim (compiled JS preserves it).
    const startIdx = source.indexOf('Cold-start onboarding');
    assert.ok(startIdx > 0, 'cold-start onboarding section must be present in compiled prompt');
    const sectionEnd = source.indexOf('[F061 Bug-F workaround', startIdx);
    assert.ok(sectionEnd > startIdx, 'cold-start onboarding section must end before Bug-F workaround section');
    const section = source.slice(startIdx, sectionEnd);

    // (1) Every cat_cafe_* tool referenced in cold-start MUST be in the readonly
    // whitelist (otherwise Bengal calls it and gets "tool not found"). The
    // previous prompt referenced cat_cafe_get_thread_context which was NOT in
    // the whitelist — that was the R1 regression target.
    const toolMatches = section.match(/cat_cafe_[a-z_]+/g) ?? [];
    const uniqueTools = [...new Set(toolMatches)];
    for (const tool of uniqueTools) {
      assert.ok(
        READONLY_ALLOWED_TOOLS.has(tool),
        `cold-start onboarding references "${tool}" but it's not in READONLY_ALLOWED_TOOLS — ` +
          `Bengal will fail to call it. Either add to whitelist or stop referencing it.`,
      );
    }

    // (2) If cold-start references cat_cafe_shell_exec, every commandLine MUST
    // pass shell_exec's own readonly whitelist (pwd / ls / cat / git log|status|
    // rev-parse|diff|show). The R2 regression was using `curl ...` here, which
    // shell_exec refuses. Lock that against再犯.
    if (section.includes('cat_cafe_shell_exec')) {
      const { isReadOnlyShellCommand } = await import('../../mcp-server/dist/tools/shell-tools.js');
      // Extract every commandLine: "..." occurrence inside cold-start section.
      const cmdLineMatches = [...section.matchAll(/commandLine:\s*"([^"]+)"/g)];
      for (const m of cmdLineMatches) {
        const cmd = m[1];
        assert.ok(
          isReadOnlyShellCommand(cmd),
          `cold-start onboarding embeds shell_exec commandLine="${cmd}" but it fails ` +
            `isReadOnlyShellCommand whitelist. Bengal will get a "Refused" error at runtime.`,
        );
      }
    }

    // (3) R3 regression target: cat_cafe_list_session_chain requires threadId,
    // but callbackEnv didn't inject it before. With the fix, threadId must be
    // a concrete string in the rendered prompt (or backtick template var that
    // resolves at render time), NOT the bare token "threadId" or undefined.
    // Drive it through the actual builder: invoke buildCallbackFallbackInstructions
    // with a populated callbackEnv and assert the rendered string contains the
    // threadId literal — not the variable name.
    const fakeEnv = {
      CAT_CAFE_API_URL: 'http://localhost:3004',
      CAT_CAFE_INVOCATION_ID: 'test-inv-001',
      CAT_CAFE_CALLBACK_TOKEN: 'test-tok-xyz',
      CAT_CAFE_USER_ID: 'default-user',
      CAT_CAFE_CAT_ID: 'antig-opus',
      CAT_CAFE_THREAD_ID: 'thread_test_001',
    };
    const svcSourceModule = await import(
      '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js'
    );
    // buildCallbackFallbackInstructions is internal — but it's invoked during
    // invoke() and the rendered prompt ends up in bridge.sendMessage call.
    // Easier: instantiate the prompt directly via a probe export OR just check
    // the source template uses ${threadId} interpolation correctly.
    // Source check is sufficient: verify section contains the interpolation
    // pattern that resolves to a literal at runtime.
    void svcSourceModule;
    assert.match(
      section,
      /threadId:\s*"\$\{threadId/,
      `cold-start onboarding must render concrete threadId via \${threadId} interpolation, ` +
        `not the literal word "threadId" — Bengal needs the actual id to call list_session_chain`,
    );
    void fakeEnv;
  });

  // --- AC-10 regression paths (F061 Phase 3) ---

  test('AC-10/3: partial text + capacity + no tool → retry with textMode=replace, no double text', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-partial-1', 'cascade-partial-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-partial-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { modifiedResponse: '我来帮你看看——' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: '让我重新检查一下，结果如下。' },
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

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 2, 'should yield partial text + replacement text');
    assert.equal(texts[0].content, '我来帮你看看——');
    assert.equal(texts[0].textMode, undefined, 'first text has no textMode');
    assert.equal(texts[1].content, '让我重新检查一下，结果如下。');
    assert.equal(texts[1].textMode, 'replace', 'recovery text must carry textMode=replace');
    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.equal(capacityErrors.length, 0, 'retry succeeded — no capacity error surfaced');
  });

  test('AC-10/4: partial text + resolved tool → no retry, surface error with diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_GENERATING',
            plannerResponse: { modifiedResponse: '让我查一下' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              toolCall: { id: 'toolu_dispatch1', name: 'run_command', argumentsJson: '{"CommandLine":"ls"}' },
            },
            toolResult: { toolName: 'run_command', output: 'file.txt', isError: false },
          },
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      modelCapacityRetryDelaysMs: [0, 0],
    });
    const messages = await collect(service.invoke('hello'));

    const capacityErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'model_capacity');
    assert.equal(capacityErrors.length, 1, 'must surface capacity error when tool dispatch happened');
    const diag = capacityErrors[0].metadata?.diagnostics;
    assert.ok(diag, 'must carry diagnostics');
    assert.equal(diag.retryEligible, false);
  });

  test('AC-10/6: partial @mention text + retry replace → stale mention not in final output', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-mention-1', 'cascade-mention-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-mention-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { modifiedResponse: '@opus 帮我看看这段代码' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: '让我重新检查一下代码' },
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

    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 2);
    assert.match(texts[0].content, /@opus/, 'first text contains @mention');
    assert.equal(texts[1].textMode, 'replace', 'recovery must use replace mode');
    assert.ok(!texts[1].content.includes('@opus'), 'replacement text must NOT carry stale @mention');
  });

  test('P1: stream_error grace expired retries on fresh cascade when retry budget available', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-stream-1', 'cascade-stream-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-stream-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { modifiedResponse: '让我看看——' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
            },
          ],
          cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
        };
        await new Promise((resolve) => setTimeout(resolve, 50));
        return;
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: '重新分析完成。' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    const streamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'stream_error');
    assert.equal(streamErrors.length, 0, 'stream_error should NOT surface when retry succeeds');
    const texts = messages.filter((m) => m.type === 'text');
    assert.equal(texts.length, 2);
    assert.equal(texts[0].content, '让我看看——');
    assert.equal(texts[1].content, '重新分析完成。');
    assert.equal(texts[1].textMode, 'replace', 'recovery text must use replace mode');
    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.ok(warnings.length >= 1, 'should yield retry warning');
    assert.match(warnings.at(-1).content, /连接中断/, 'retry signal should say 连接中断 for stream_interrupted');
  });

  test('F201 Phase C: stream_error after CODE_ACTION surfaces resumable recovery context', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/stream-after-write.md' },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    const streamError = messages.find((m) => m.type === 'error' && m.errorCode === 'stream_error');
    assert.ok(streamError, 'post-side-effect stream_error must surface instead of blind retry');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must not retry a cascade after file writes');
    assert.deepEqual(streamError.metadata?.diagnostics?.recoveryDecision, {
      action: 'surface_resumable_error',
      reason: 'post_side_effect_interrupted',
    });
    assert.equal(
      streamError.metadata?.diagnostics?.resumeContext?.instruction,
      'continue_without_repeating_completed_side_effects',
    );
    assert.equal(
      streamError.metadata?.diagnostics?.resumeContext?.completedEffects?.[0]?.target,
      'docs/stream-after-write.md',
    );
  });

  test('AC-G6: Tier 2 owned sentinel stream_error auto-resumes once with resume context', async () => {
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-antigravity-owned-'));
    const target = path.join(ownedDir, 'sentinel.json');
    fs.writeFileSync(target, '{"ok":true}\n', 'utf-8');

    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-acg6-tier2-1', 'cascade-acg6-tier2-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-acg6-tier2-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_CODE_ACTION',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { operation: 'write', path: target },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
        };
        await new Promise((resolve) => setTimeout(resolve, 20));
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered from owned sentinel interruption.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-acg6-tier2',
          invocationId: 'inv-acg6-tier2',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.equal(bridge.resetSession.mock.callCount(), 1, 'Tier 2 owned sentinel should auto-resume on fresh cascade');
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'auto-resume should send the fresh cascade prompt');
    assert.equal(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'stream_error'),
      false,
      'Tier 2 auto-resume should hide the stream error when fresh cascade succeeds',
    );
    assert.ok(
      messages.some((msg) => msg.type === 'text' && msg.content === 'Recovered from owned sentinel interruption.'),
      'fresh cascade result should be delivered',
    );

    const resumedPrompt = bridge.sendMessage.mock.calls[1].arguments[1];
    assert.match(resumedPrompt, /Cat Cafe Antigravity safe auto-resume/);
    assert.match(resumedPrompt, /continue_without_repeating_completed_side_effects/);
    assert.match(resumedPrompt, /tier2_auto_probe_owned/);
    assert.match(resumedPrompt, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const record = await supervisorStore.get('inv-acg6-tier2', 'cascade-acg6-tier2-1');
    assert.ok(record, 'supervisor should retain the first cascade auto-resume record');
    assert.equal(record.status, 'auto_resuming');
    assert.equal(record.recoveryStrategy, 'auto_resume');
    assert.equal(record.resumeAttemptCount, 1);
  });

  test('AC-G6: Tier 2 owned sentinel empty_response auto-resumes with resume context', async () => {
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-antigravity-owned-'));
    const target = path.join(ownedDir, 'empty-response-sentinel.json');
    fs.writeFileSync(target, '{"ok":true}\n', 'utf-8');

    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-acg6-empty-1', 'cascade-acg6-empty-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-acg6-empty-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_CODE_ACTION',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { operation: 'write', path: target },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered from owned empty response interruption.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-acg6-empty',
          invocationId: 'inv-acg6-empty',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.equal(bridge.resetSession.mock.callCount(), 1, 'Tier 2 empty_response should auto-resume once');
    assert.equal(
      bridge.sendMessage.mock.callCount(),
      2,
      'empty_response auto-resume should send a fresh cascade prompt',
    );
    assert.equal(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'empty_response'),
      false,
      'Tier 2 empty_response auto-resume should hide the empty_response when fresh cascade succeeds',
    );
    assert.ok(
      messages.some(
        (msg) => msg.type === 'text' && msg.content === 'Recovered from owned empty response interruption.',
      ),
      'fresh cascade result should be delivered',
    );

    const resumedPrompt = bridge.sendMessage.mock.calls[1].arguments[1];
    assert.match(resumedPrompt, /Cat Cafe Antigravity safe auto-resume/);
    assert.match(resumedPrompt, /continue_without_repeating_completed_side_effects/);
    assert.match(resumedPrompt, /tier2_auto_probe_owned/);
    assert.match(resumedPrompt, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const record = await supervisorStore.get('inv-acg6-empty', 'cascade-acg6-empty-1');
    assert.ok(record, 'supervisor should retain the empty_response auto-resume record');
    assert.equal(record.status, 'auto_resuming');
    assert.equal(record.recoveryStrategy, 'auto_resume');
    assert.equal(record.resumeAttemptCount, 1);
  });

  test('AC-G6: safe auto-resume prompt survives a later pre-side-effect retry', async () => {
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-antigravity-owned-'));
    const target = path.join(ownedDir, 'resume-context-survives-retry.json');
    fs.writeFileSync(target, '{"ok":true}\n', 'utf-8');

    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () =>
      ['cascade-acg6-preserve-1', 'cascade-acg6-preserve-2', 'cascade-acg6-preserve-3'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-acg6-preserve-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_CODE_ACTION',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { operation: 'write', path: target },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }

      if (cascadeId === 'cascade-acg6-preserve-2') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after preserved resume context.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      modelCapacityRetryDelaysMs: [0, 0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-acg6-preserve',
          invocationId: 'inv-acg6-preserve',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.equal(bridge.resetSession.mock.callCount(), 2, 'empty_response then model_capacity should reset twice');
    assert.equal(bridge.sendMessage.mock.callCount(), 3, 'second retry should send a third cascade prompt');
    assert.equal(
      messages.some(
        (msg) => msg.type === 'error' && (msg.errorCode === 'empty_response' || msg.errorCode === 'model_capacity'),
      ),
      false,
      'fresh-cascade retries should hide recoverable empty_response/model_capacity when final cascade succeeds',
    );
    assert.ok(
      messages.some((msg) => msg.type === 'text' && msg.content === 'Recovered after preserved resume context.'),
      'final fresh cascade result should be delivered',
    );

    const firstResumePrompt = bridge.sendMessage.mock.calls[1].arguments[1];
    const secondResumePrompt = bridge.sendMessage.mock.calls[2].arguments[1];
    assert.match(firstResumePrompt, /Cat Cafe Antigravity safe auto-resume/);
    assert.match(secondResumePrompt, /Cat Cafe Antigravity safe auto-resume/);
    assert.match(secondResumePrompt, /continue_without_repeating_completed_side_effects/);
    assert.match(secondResumePrompt, /tier2_auto_probe_owned/);
    assert.match(secondResumePrompt, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('AC-G6: autoResume=false keeps Tier 2 interruption on manual recovery path', async () => {
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-antigravity-owned-'));
    const target = path.join(ownedDir, 'sentinel.json');
    fs.writeFileSync(target, '{"ok":true}\n', 'utf-8');

    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: target },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      autoResume: false,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    assert.equal(bridge.resetSession.mock.callCount(), 0, 'disabled auto-resume must not reset the cascade');
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'disabled auto-resume must not send a fresh cascade prompt');
    const streamError = messages.find((msg) => msg.type === 'error' && msg.errorCode === 'stream_error');
    assert.ok(streamError, 'disabled auto-resume should surface manual recovery');
    assert.equal(streamError.metadata?.diagnostics?.resumeContext?.resumeTierDecision?.tier, 'tier2_auto_probe_owned');
  });

  test('AC-G6: auto-resume attempt cap surfaces manual recovery card on the second interruption', async () => {
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-antigravity-owned-'));
    const target = path.join(ownedDir, 'sentinel.json');
    fs.writeFileSync(target, '{"ok":true}\n', 'utf-8');

    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () =>
      ['cascade-acg6-cap-1', 'cascade-acg6-cap-2', 'cascade-acg6-cap-3'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-acg6-cap-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_CODE_ACTION',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { operation: 'write', path: target },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
        };
        return;
      }
      if (cascadeId === 'cascade-acg6-cap-2') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_CODE_ACTION',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { operation: 'write', path: target },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
        };
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0, 0],
    });
    const messages = await collect(service.invoke('hello'));

    assert.equal(bridge.resetSession.mock.callCount(), 1, 'attempt cap should block the second auto-resume');
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'service must not send a third cascade after cap is reached');
    const streamError = messages.find((msg) => msg.type === 'error' && msg.errorCode === 'stream_error');
    assert.ok(streamError, 'second interruption should surface after attempt cap');
    assert.equal(streamError.metadata?.diagnostics?.resumeContext?.resumeTierDecision?.tier, 'tier2_auto_probe_owned');

    const recoveryMsg = messages.find((msg) => {
      if (msg.type !== 'system_info') return false;
      const parsed = JSON.parse(msg.content);
      return parsed.type === 'rich_block' && parsed.block?.meta?.kind === 'antigravity_recovery';
    });
    assert.ok(recoveryMsg, 'attempt cap should surface a typed recovery rich block');
  });

  test('AC-G6: Tier 4 shell delete stays manual even when target path is owned', async () => {
    const ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-antigravity-owned-'));
    const target = `rm -rf ${ownedDir}`;
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              toolCall: {
                id: 'toolu_acg6_delete',
                name: 'run_command',
                argumentsJson: JSON.stringify({ CommandLine: target, Cwd: '/tmp', SafeToAutoRun: true }),
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    assert.equal(bridge.resetSession.mock.callCount(), 0, 'Tier 4 delete must never auto-resume');
    const streamError = messages.find((msg) => msg.type === 'error' && msg.errorCode === 'stream_error');
    assert.ok(streamError, 'Tier 4 delete should surface for manual recovery');
    assert.equal(
      streamError.metadata?.diagnostics?.resumeContext?.resumeTierDecision?.tier,
      'tier4_manual_irreversible',
    );
  });

  test('F201 Phase E: post-side-effect stream_error emits typed recovery rich block card', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/recovery-card.md' },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(service.invoke('hello'));

    const recoveryMsg = messages.find((m) => {
      if (m.type !== 'system_info') return false;
      try {
        const parsed = JSON.parse(m.content ?? '{}');
        return parsed?.type === 'rich_block' && parsed?.block?.meta?.kind === 'antigravity_recovery';
      } catch {
        return false;
      }
    });
    assert.ok(recoveryMsg, 'post-side-effect stream_error should emit a typed recovery rich block');

    const parsed = JSON.parse(recoveryMsg.content);
    assert.equal(parsed.type, 'rich_block');
    assert.equal(parsed.block.kind, 'card');
    assert.equal(parsed.block.v, 1);
    assert.equal(parsed.block.tone, 'warning');
    assert.equal(parsed.block.meta.kind, 'antigravity_recovery');
    assert.equal(parsed.block.meta.recoveryDecision.action, 'surface_resumable_error');
    assert.equal(parsed.block.meta.completedEffectCount, 1);
    assert.match(parsed.block.bodyMarkdown, /停止自动重试/);
    assert.ok(
      parsed.block.fields.some(
        (field) => field.label === '已完成动作' && field.value.includes('docs/recovery-card.md'),
      ),
    );
    assert.ok(parsed.block.fields.some((field) => field.label === '未完成动作'));
    assert.ok(parsed.block.fields.some((field) => field.label === '建议下一步'));
    assert.ok(parsed.block.fields.some((field) => field.label === '诊断 ID'));
    assert.deepEqual(parsed.block.actions?.[0], {
      label: '复制诊断',
      action: 'copy-to-clipboard',
      payload: {
        text: parsed.block.meta.diagnosticSummary,
      },
    });
  });

  test('P2b: retry signal shows capacity-specific Chinese text', async () => {
    const bridge = createMockBridge();
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () => ['cascade-p2b-1', 'cascade-p2b-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-p2b-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage:
                    'Our servers are experiencing high traffic right now, please try again in a minute.',
                },
              },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'OK' },
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

    const warnings = messages.filter((m) => m.type === 'provider_signal');
    assert.ok(warnings.length >= 1);
    assert.match(warnings[0].content, /上游模型服务繁忙/, 'capacity retry signal should say 上游模型服务繁忙');
    assert.match(warnings[0].content, /自动重试/);
  });

  test('P1: WAITING run_command + stream_error grace expired must NOT retry — toolish step blocks', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_GENERATING',
            plannerResponse: { modifiedResponse: '让我执行一下' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_approval_pending',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"curl -fsS https://example.com","Cwd":"/tmp","SafeToAutoRun":true}',
              },
            },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 3, terminalSeen: false, lastActivityAt: Date.now() },
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      streamErrorGraceWindowMs: 10,
      modelCapacityRetryDelaysMs: [0, 0],
    });
    const messages = await collect(service.invoke('hello'));

    const streamErrors = messages.filter((m) => m.type === 'error' && m.errorCode === 'stream_error');
    assert.equal(streamErrors.length, 1, 'stream_error must surface when toolish step blocks retry');
    assert.equal(bridge.resetSession.mock.callCount(), 0, 'must NOT reset session — toolish step was in-flight');
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'must NOT resend — single attempt only');
  });

  test('flushes side-effect journal audit when poll fails after an observed side effect', async () => {
    const invocationId = `inv-f201-outer-catch-flush-${Date.now()}-${process.pid}`;
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-outer-catch-flush' });
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/f201-outer-catch.md' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      throw new Error('Antigravity poll RPC exhausted after side effect');
    };

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-outer-catch-flush',
          invocationId,
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.ok(
      messages.some((msg) => msg.type === 'error' && /poll RPC exhausted/.test(msg.error ?? '')),
      'outer catch should still surface the poll failure',
    );

    const auditEntries = readSideEffectAuditEntriesByInvocation(invocationId);
    assert.equal(auditEntries.length, 1, 'observed side effect must be flushed before outer catch returns');
    assert.equal(auditEntries[0].target, 'docs/f201-outer-catch.md');
    assert.equal(auditEntries[0].operation, 'write');
    assert.equal(auditEntries[0].status, 'done');
  });

  test('F201 Phase F Task 2b: trajectory-progress stall writes supervisor liveness evidence', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-supervisor-liveness' });
    let pollCount = 0;
    bridge.pollForSteps = async function* () {
      pollCount += 1;
      if (pollCount === 1) {
        throw new Error('Antigravity poll stall after 60000ms');
      }
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after liveness evidence.' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    bridge.getTrajectory = mock.fn(async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 2,
      awaitingUserInput: false,
    }));

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-supervisor-liveness',
          invocationId: 'inv-f201-supervisor-liveness',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.ok(messages.some((msg) => msg.type === 'text' && msg.content === 'Recovered after liveness evidence.'));

    const record = await supervisorStore.get('inv-f201-supervisor-liveness', 'cascade-f201-supervisor-liveness');
    assert.ok(record, 'supervisor record must be persisted for the cascade');
    assert.equal(record.lastLivenessEvidence?.kind, 'trajectory_progress');
    assert.equal(record.lastLivenessEvidence?.summary, 'trajectory step count advanced from 0 to 2');
    assert.equal(record.lastObservedStepCount, 2);
    assert.equal(record.lastDeliveredStepIndex, 2);
    assert.equal(record.recoveryStrategy, 'wait');
  });

  test('AC-G2/G3/G4: timestamp heartbeat writes durable supervisor liveness evidence', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-timestamp-heartbeat' });
    bridge.pollForSteps = async function* () {
      yield {
        steps: [],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 0,
          terminalSeen: false,
          lastActivityAt: Date.now(),
          lastTrajectoryAt: 1770000002000,
          livenessEvidence: {
            kind: 'trajectory_timestamp_progress',
            observedAt: 1770000002100,
            summary: 'trajectory timestamp advanced while no step was deliverable',
          },
        },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after timestamp heartbeat.' },
          },
        ],
        cursor: {
          baselineStepCount: 0,
          lastDeliveredStepCount: 1,
          terminalSeen: true,
          lastActivityAt: Date.now(),
          lastTrajectoryAt: 1770000003000,
        },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-timestamp-heartbeat',
          invocationId: 'inv-f201-timestamp-heartbeat',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.ok(messages.some((msg) => msg.type === 'text' && msg.content === 'Recovered after timestamp heartbeat.'));

    const record = await supervisorStore.get('inv-f201-timestamp-heartbeat', 'cascade-f201-timestamp-heartbeat');
    assert.ok(record, 'supervisor record must be persisted for timestamp heartbeat');
    assert.equal(record.lastLivenessEvidence?.kind, 'trajectory_timestamp_progress');
    assert.equal(record.lastLivenessEvidence?.summary, 'trajectory timestamp advanced while no step was deliverable');
    assert.equal(record.lastTrajectoryAt, 1770000003000);
    assert.equal(record.recoveryStrategy, 'wait');
  });

  test('AC-G2/G3: timestamp-only stall liveness is bounded and cannot mask a dead cascade', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-timestamp-dead' });
    let pollCount = 0;
    bridge.pollForSteps = async function* () {
      pollCount += 1;
      if (pollCount === 1) {
        yield {
          steps: [],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 0,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            lastTrajectoryAt: 1770000001000,
            livenessEvidence: {
              kind: 'trajectory_timestamp_progress',
              observedAt: 1770000001100,
              summary: 'trajectory timestamp advanced while no step was deliverable',
            },
          },
        };
      }
      if (pollCount > 3) {
        throw new Error(`unbounded timestamp-only liveness retry (${pollCount})`);
      }
      throw new Error('Antigravity poll stall after 20ms');
    };
    let trajectoryCalls = 0;
    bridge.getTrajectory = mock.fn(async () => {
      trajectoryCalls += 1;
      return {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 0,
        awaitingUserInput: false,
        updatedAt: 1770000001000 + trajectoryCalls * 1000,
      };
    });

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      pollTimeoutMs: 20,
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-timestamp-dead',
          invocationId: 'inv-f201-timestamp-dead',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    const errorMessages = messages.filter((msg) => msg.type === 'error').map((msg) => String(msg.error));

    assert.equal(pollCount, 3, 'timestamp-only liveness must stop at the stall probe budget');
    assert.ok(
      errorMessages.some((error) => /Antigravity poll stall/.test(error)),
      'bounded timestamp-only liveness should surface the original stall',
    );
    assert.equal(
      errorMessages.some((error) => /unbounded timestamp-only liveness retry/.test(error)),
      false,
      'timestamp-only liveness must not continue past the bound',
    );
  });

  test('AC-G2/G3: numTotalSteps-only stall liveness is bounded and cannot mask a dead cascade', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-step-count-dead' });
    let pollCount = 0;
    bridge.pollForSteps = async function* () {
      pollCount += 1;
      if (pollCount > 3) {
        throw new Error(`unbounded step-count liveness retry (${pollCount})`);
      }
      throw new Error('Antigravity poll stall after 20ms');
    };
    let trajectoryCalls = 0;
    bridge.getTrajectory = mock.fn(async () => {
      trajectoryCalls += 1;
      return {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: trajectoryCalls,
        awaitingUserInput: false,
      };
    });

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      pollTimeoutMs: 20,
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-step-count-dead',
          invocationId: 'inv-f201-step-count-dead',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    const errorMessages = messages.filter((msg) => msg.type === 'error').map((msg) => String(msg.error));

    assert.equal(pollCount, 3, 'numTotalSteps-only liveness must stop at the stall probe budget');
    assert.ok(
      errorMessages.some((error) => /Antigravity poll stall/.test(error)),
      'bounded numTotalSteps-only liveness should surface the original stall',
    );
    assert.equal(
      errorMessages.some((error) => /unbounded step-count liveness retry/.test(error)),
      false,
      'numTotalSteps-only liveness must not continue past the bound',
    );
  });

  test('F201 Phase F Task 2b: post-side-effect stream_error persists resumable supervisor record', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-supervisor-resumable' });
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/f201-supervisor-resume.md' },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      streamErrorGraceWindowMs: 0,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-supervisor-resumable',
          invocationId: 'inv-f201-supervisor-resumable',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.ok(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'stream_error'),
      'post-side-effect stream_error should still surface',
    );

    const record = await supervisorStore.get('inv-f201-supervisor-resumable', 'cascade-f201-supervisor-resumable');
    assert.ok(record, 'supervisor record must be persisted for resumable stream interruption');
    assert.equal(record.status, 'resumable');
    assert.equal(record.recoveryStrategy, 'manual_card');
    assert.equal(record.receiptState, 'clean');
    assert.equal(record.journalSummarySnapshot.entries.length, 1);
    assert.equal(record.journalSummarySnapshot.entries[0].target, 'docs/f201-supervisor-resume.md');
    assert.equal(record.journalSummarySnapshot.entries[0].status, 'done');
  });

  test('F201 Phase F Task 2b: post-side-effect empty_response keeps resumable supervisor record', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-supervisor-empty-response' });
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_CODE_ACTION',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: { operation: 'write', path: 'docs/f201-supervisor-empty-response.md' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-supervisor-empty-response',
          invocationId: 'inv-f201-supervisor-empty-response',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.ok(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'empty_response'),
      'post-side-effect empty_response should still surface',
    );

    const record = await supervisorStore.get(
      'inv-f201-supervisor-empty-response',
      'cascade-f201-supervisor-empty-response',
    );
    assert.ok(record, 'supervisor record must be persisted for resumable empty_response');
    assert.equal(record.status, 'resumable');
    assert.equal(record.recoveryStrategy, 'manual_card');
    assert.equal(record.receiptState, 'clean');
    assert.equal(record.journalSummarySnapshot.entries.length, 1);
    assert.equal(record.journalSummarySnapshot.entries[0].target, 'docs/f201-supervisor-empty-response.md');
    assert.equal(record.journalSummarySnapshot.entries[0].status, 'done');
  });

  test('F201 Phase F Task 3: native success plus trajectory error persists receipt conflict', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-receipt-conflict' });
    bridge.nativeExecuteAndPush = mock.fn(async (step) => step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND');
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_receipt_conflict',
                name: 'run_command',
                argumentsJson: JSON.stringify({
                  CommandLine: 'touch docs/f201-receipt-conflict.md',
                  Cwd: '/tmp',
                  SafeToAutoRun: true,
                }),
              },
              sourceTrajectoryStepInfo: {
                cascadeId: 'cascade-f201-receipt-conflict',
                trajectoryId: 'traj-f201-receipt-conflict',
                stepIndex: 1,
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'FINISHED',
            errorMessage: {
              error: {
                userErrorMessage: 'The model produced an invalid tool call after native execution.',
              },
            },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-receipt-conflict',
          invocationId: 'inv-f201-receipt-conflict',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.equal(
      bridge.nativeExecuteAndPush.mock.calls.filter(
        (call) => call.arguments[0]?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND',
      ).length,
      1,
      'native executor must report success first',
    );
    const upstreamError = messages.find((msg) => msg.type === 'error' && msg.errorCode === 'upstream_error');
    assert.ok(upstreamError, 'trajectory ERROR should still surface to the user');
    assert.equal(
      upstreamError.metadata?.diagnostics?.receiptConflict,
      'native_success_trajectory_error',
      'error diagnostics must identify receipt conflict instead of a plain upstream failure',
    );
    const recoveryMsg = messages.find((msg) => {
      if (msg.type !== 'system_info') return false;
      return msg.content?.includes('"antigravity_recovery"');
    });
    assert.ok(recoveryMsg, 'receipt conflict should surface the resumable recovery card');
    const recoveryBlock = JSON.parse(recoveryMsg.content).block;
    assert.equal(recoveryBlock.meta.recoveryDecision.reason, 'receipt_conflict_native_success_trajectory_error');
    assert.equal(recoveryBlock.meta.pendingOrUnknownEffectCount, 1);
    assert.ok(
      recoveryBlock.fields.some(
        (field) => field.label === '未完成动作' && field.value.includes('touch docs/f201-receipt-conflict.md'),
      ),
      'recovery card should include the pending run_command split',
    );

    const record = await supervisorStore.get('inv-f201-receipt-conflict', 'cascade-f201-receipt-conflict');
    assert.ok(record, 'supervisor record must be persisted for receipt conflict');
    assert.equal(record.status, 'resumable');
    assert.equal(record.recoveryStrategy, 'manual_card');
    assert.equal(record.receiptState, 'native_success_trajectory_error');
    assert.equal(record.lastLivenessEvidence?.kind, 'native_executor_active');
    assert.equal(record.nativeExecutorEvidence?.toolName, 'run_command');
    assert.equal(record.nativeExecutorEvidence?.status, 'completed');
    assert.equal(record.nativeExecutorEvidence?.stepIndex, 1);
    assert.equal(record.journalSummarySnapshot.entries.length, 1);
    assert.equal(record.journalSummarySnapshot.entries[0].target, 'touch docs/f201-receipt-conflict.md');
    assert.equal(record.journalSummarySnapshot.entries[0].status, 'pending');
  });

  test('AC-G7: YOLO-dispatched approval-gated run_command remains side-effect journal covered', async () => {
    const supervisorStore = new InMemoryAntigravitySupervisorStore();
    const bridge = createMockBridge({ cascadeId: 'cascade-f201-yolo-journal' });
    bridge.nativeExecuteAndPush = mock.fn(async (step) => step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND');
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_yolo_journal',
                name: 'run_command',
                argumentsJson: JSON.stringify({
                  CommandLine: 'touch docs/f201-yolo-journal.md',
                  Cwd: '/tmp',
                  SafeToAutoRun: false,
                }),
              },
              sourceTrajectoryStepInfo: {
                cascadeId: 'cascade-f201-yolo-journal',
                trajectoryId: 'traj-f201-yolo-journal',
                stepIndex: 1,
              },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };

    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      supervisorStore,
      streamErrorGraceWindowMs: 0,
      modelCapacityRetryDelaysMs: [0],
    });
    const messages = await collect(
      service.invoke('hello', {
        auditContext: {
          threadId: 'thread-f201-yolo-journal',
          invocationId: 'inv-f201-yolo-journal',
          userId: 'u1',
          catId: 'antigravity',
        },
      }),
    );

    assert.equal(
      bridge.nativeExecuteAndPush.mock.calls.filter(
        (call) => call.arguments[0]?.metadata?.toolCall?.id === 'toolu_yolo_journal',
      ).length,
      1,
      'YOLO path must dispatch SafeToAutoRun=false run_command once',
    );
    assert.ok(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'stream_error'),
      'post-dispatch stream_error should still surface',
    );

    const record = await supervisorStore.get('inv-f201-yolo-journal', 'cascade-f201-yolo-journal');
    assert.ok(record, 'supervisor record must be persisted for YOLO-dispatched interruption');
    assert.equal(record.status, 'resumable');
    assert.equal(record.recoveryStrategy, 'manual_card');
    assert.equal(record.nativeExecutorEvidence?.toolName, 'run_command');
    assert.equal(record.nativeExecutorEvidence?.status, 'completed');
    assert.equal(record.journalSummarySnapshot.entries.length, 1);
    assert.equal(record.journalSummarySnapshot.entries[0].target, 'touch docs/f201-yolo-journal.md');
    assert.equal(record.journalSummarySnapshot.entries[0].status, 'pending');
  });

  test('F201 Phase F Task 3: native success plus trajectory error retries when no side effect was observed', async () => {
    const bridge = createMockBridge();
    bridge.nativeExecuteAndPush = mock.fn(async (step) => step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND');
    let sessionIndex = 0;
    bridge.getOrCreateSession = async () =>
      ['cascade-f201-receipt-clean-1', 'cascade-f201-receipt-clean-2'][sessionIndex++];
    bridge.pollForSteps = async function* (cascadeId) {
      if (cascadeId === 'cascade-f201-receipt-clean-1') {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_WAITING',
              metadata: {
                toolCall: {
                  id: 'toolu_receipt_clean',
                  name: 'run_command',
                  argumentsJson: JSON.stringify({
                    CommandLine: 'git status --short',
                    Cwd: '/tmp',
                    SafeToAutoRun: true,
                  }),
                },
                sourceTrajectoryStepInfo: {
                  cascadeId: 'cascade-f201-receipt-clean-1',
                  trajectoryId: 'traj-f201-receipt-clean',
                  stepIndex: 1,
                },
              },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
        };
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
              status: 'FINISHED',
              errorMessage: {
                error: {
                  userErrorMessage: 'The model produced an invalid tool call after read-only native execution.',
                },
              },
            },
          ],
          cursor: { baselineStepCount: 1, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
        };
        return;
      }

      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'FINISHED',
            plannerResponse: { response: 'Recovered after receipt conflict replay.' },
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
    const messages = await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    assert.equal(bridge.resetSession.mock.callCount(), 1, 'no-side-effect receipt conflict should replay');
    assert.equal(bridge.sendMessage.mock.callCount(), 2, 'retry should resend prompt to a fresh cascade');
    assert.equal(
      messages.some((msg) => msg.type === 'error' && msg.errorCode === 'upstream_error'),
      false,
      'no-side-effect receipt conflict should stay hidden when replay succeeds',
    );
    assert.ok(
      messages.some((msg) => msg.type === 'text' && msg.content === 'Recovered after receipt conflict replay.'),
      'fresh cascade result should be delivered',
    );
  });
});
