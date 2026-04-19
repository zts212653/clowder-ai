import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { collect, createMockBridge } from './antigravity-agent-service-test-helpers.js';

describe('AntigravityAgentService (Bridge) — diagnostics', () => {
  test('empty_response includes diagnostic metadata with step counts', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' },
          { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' },
          {
            type: 'CORTEX_STEP_TYPE_TOOL_CALL',
            status: 'CORTEX_STEP_STATUS_DONE',
            toolCall: { toolName: 'read_file', input: '{}' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test'));

    const errMsg = messages.find((m) => m.type === 'error' && m.errorCode === 'empty_response');
    assert.ok(errMsg, 'should emit empty_response');
    assert.ok(errMsg.metadata.diagnostics, 'empty_response must include diagnostics metadata');
    assert.equal(errMsg.metadata.diagnostics.totalStepsSeen, 3);
    assert.deepEqual(errMsg.metadata.diagnostics.rawStepTypeCounts, {
      CORTEX_STEP_TYPE_CHECKPOINT: 2,
      CORTEX_STEP_TYPE_TOOL_CALL: 1,
    });
    assert.equal(errMsg.metadata.diagnostics.hasText, false);
    assert.equal(errMsg.metadata.diagnostics.fatalSeen, false);
  });

  test('empty_response diagnostics includes unknown step types for taxonomy gap detection', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          { type: 'CORTEX_STEP_TYPE_GREP_SEARCH', status: 'CORTEX_STEP_STATUS_DONE' },
          { type: 'CORTEX_STEP_TYPE_GREP_SEARCH', status: 'CORTEX_STEP_STATUS_DONE' },
          { type: 'CORTEX_STEP_TYPE_FILE_EDIT', status: 'CORTEX_STEP_STATUS_DONE' },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test'));

    const errMsg = messages.find((m) => m.type === 'error' && m.errorCode === 'empty_response');
    assert.ok(errMsg, 'should emit empty_response for unknown-only steps');
    const diag = errMsg.metadata.diagnostics;
    assert.equal(diag.totalStepsSeen, 3);
    assert.deepEqual(diag.rawStepTypeCounts, {
      CORTEX_STEP_TYPE_GREP_SEARCH: 2,
      CORTEX_STEP_TYPE_FILE_EDIT: 1,
    });
    assert.ok(diag.transformedMessageTypeCounts, 'should include transformed message type counts');
  });

  test('thinking-only planner response still triggers empty_response with planner/system_info diagnostics', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { thinking: 'Let me think...' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test'));

    const thinkingMsg = messages.find((m) => m.type === 'system_info');
    assert.ok(thinkingMsg, 'thinking-only planner response should still emit system_info');

    const errMsg = messages.find((m) => m.type === 'error' && m.errorCode === 'empty_response');
    assert.ok(errMsg, 'thinking-only planner response should still emit empty_response');
    const diag = errMsg.metadata.diagnostics;
    assert.deepEqual(diag.rawStepTypeCounts, {
      CORTEX_STEP_TYPE_PLANNER_RESPONSE: 1,
    });
    assert.deepEqual(diag.transformedMessageTypeCounts, {
      system_info: 1,
    });
    assert.deepEqual(diag.lastBatchStepTypes, ['CORTEX_STEP_TYPE_PLANNER_RESPONSE']);
    assert.equal(diag.hasText, false);
  });

  test('empty_response diagnostics tracks across multiple batches', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [{ type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' }],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_TOOL_CALL',
            status: 'CORTEX_STEP_STATUS_DONE',
            toolCall: { toolName: 'ls', input: '{}' },
          },
          {
            type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
            status: 'CORTEX_STEP_STATUS_DONE',
            toolResult: { toolName: 'ls', output: 'files', success: true },
          },
        ],
        cursor: { baselineStepCount: 1, lastDeliveredStepCount: 3, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test'));

    const errMsg = messages.find((m) => m.type === 'error' && m.errorCode === 'empty_response');
    assert.ok(errMsg);
    const diag = errMsg.metadata.diagnostics;
    assert.equal(diag.totalStepsSeen, 3, 'should count steps across all batches');
    assert.equal(diag.lastDelivered, 3);
    assert.deepEqual(diag.lastBatchStepTypes, ['CORTEX_STEP_TYPE_TOOL_CALL', 'CORTEX_STEP_TYPE_TOOL_RESULT']);
  });

  test('keeps partial text when the same planner step grows before terminal idle', async () => {
    const bridge = createMockBridge();
    bridge.pollForSteps = async function* () {
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { modifiedResponse: '铲屎官，我活着，' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: false, lastActivityAt: Date.now() },
      };
      yield {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            plannerResponse: { modifiedResponse: '喵。' },
          },
        ],
        cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
      };
    };
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('test'));

    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.deepEqual(texts, ['铲屎官，我活着，', '喵。']);
    const emptyErrs = messages.filter((m) => m.type === 'error' && m.errorCode === 'empty_response');
    assert.equal(emptyErrs.length, 0, 'partial text path must not regress into empty_response');
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('no diagnostics metadata on successful text response', async () => {
    const bridge = createMockBridge();
    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'gemini-3.1-pro', bridge });
    const messages = await collect(service.invoke('test'));

    const textMsg = messages.find((m) => m.type === 'text');
    assert.ok(textMsg);
    assert.equal(textMsg.metadata.diagnostics, undefined, 'successful responses should not have diagnostics');
  });
});
