import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { collect, createMockBridge } from './antigravity-agent-service-test-helpers.js';

describe('AntigravityAgentService (Bridge) — native executors', () => {
  test('aborted signal prevents execution', async () => {
    const bridge = createMockBridge();
    const controller = new AbortController();
    controller.abort();
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test', { signal: controller.signal }));

    assert.equal(bridge.sendMessage.mock.callCount(), 0);
    assert.equal(messages[0].type, 'error');
    assert.ok(messages[0].error.includes('Aborted'));
  });

  test('dispatches WAITING RUN_COMMAND steps to bridge.nativeExecuteAndPush', async () => {
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: { id: 'toolu_1', name: 'run_command', argumentsJson: '{"CommandLine":"echo hi","Cwd":"/tmp"}' },
        sourceTrajectoryStepInfo: { cascadeId: 'test-cascade-001', trajectoryId: 't1', stepIndex: 0 },
      },
    };
    const textStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { response: 'ok' },
    };
    const bridge = createMockBridge({ steps: [waitingStep, textStep] });
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    await collect(service.invoke('do it', { workingDirectory: '/tmp' }));

    assert.ok(bridge.nativeExecuteAndPush.mock.callCount() >= 1, 'should dispatch at least once');
    const dispatchedStep = bridge.nativeExecuteAndPush.mock.calls.find(
      (c) => c.arguments[0]?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND',
    );
    assert.ok(dispatchedStep, 'should dispatch the WAITING RUN_COMMAND step');
    assert.equal(dispatchedStep.arguments[1].cascadeId, 'test-cascade-001');
    assert.equal(dispatchedStep.arguments[1].cwd, '/tmp');
  });

  test('skips nativeExecuteAndPush when terminalAbort is set in same batch', async () => {
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
            status: 'CORTEX_STEP_STATUS_WAITING',
            metadata: {
              toolCall: {
                id: 'toolu_after_abort',
                name: 'run_command',
                argumentsJson: '{"CommandLine":"rm -rf /","Cwd":"/tmp"}',
              },
              sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 3 },
            },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 2, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    await collect(service.invoke('hello', { workingDirectory: '/tmp' }));

    assert.equal(
      bridge.nativeExecuteAndPush.mock.callCount(),
      0,
      'must NOT dispatch native executor after terminal error in same batch',
    );
  });

  test('auto-attaches default executors when service constructs its own bridge', () => {
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro' });
    const bridge = service['bridge'];
    assert.ok(bridge['executorRegistry'], 'executor registry should be attached');
    assert.ok(bridge['executorAudit'], 'audit sink should be attached');
    assert.ok(bridge['executorRegistry'].size() >= 1, 'registry should have at least RunCommandExecutor');
  });

  test('deduplicates re-delivered WAITING step by toolCall id', async () => {
    const waitingStep = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: { id: 'toolu_dedup', name: 'run_command', argumentsJson: '{"CommandLine":"ls","Cwd":"/tmp"}' },
        sourceTrajectoryStepInfo: { cascadeId: 'c1', trajectoryId: 't1', stepIndex: 0 },
      },
    };
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [waitingStep],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          waitingStep,
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { response: 'done' },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    bridge.nativeExecuteAndPush = mock.fn(async () => true);
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    await collect(service.invoke('test', { workingDirectory: '/tmp' }));

    const runCmdCalls = bridge.nativeExecuteAndPush.mock.calls.filter(
      (c) => c.arguments[0]?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND',
    );
    assert.equal(runCmdCalls.length, 1, 'same toolCall id must only dispatch once');
  });
});
