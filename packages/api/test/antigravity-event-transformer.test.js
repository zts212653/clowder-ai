import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyStep,
  transformTrajectorySteps,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-event-transformer.js';

const catId = 'antigravity';
const metadata = { provider: 'antigravity', model: 'gemini-3.1-pro' };

// ── G1: Step Taxonomy ──────────────────────────────────────────────

describe('G1: classifyStep — 6-bucket taxonomy', () => {
  test('PLANNER_RESPONSE with text → terminal_output', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'FINISHED',
      plannerResponse: { response: 'Hello world' },
    };
    assert.equal(classifyStep(step), 'terminal_output');
  });

  test('PLANNER_RESPONSE with modifiedResponse → terminal_output', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'FINISHED',
      plannerResponse: { modifiedResponse: 'Modified text' },
    };
    assert.equal(classifyStep(step), 'terminal_output');
  });

  test('PLANNER_RESPONSE with thinking only → thinking', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'FINISHED',
      plannerResponse: { thinking: 'Let me reason about this...' },
    };
    assert.equal(classifyStep(step), 'thinking');
  });

  test('PLANNER_RESPONSE with thinking AND text → terminal_output', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'FINISHED',
      plannerResponse: { thinking: 'hmm', response: 'Here is the answer' },
    };
    assert.equal(classifyStep(step), 'terminal_output');
  });

  test('PLANNER_RESPONSE with stream error → tool_error', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'FINISHED',
      plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
    };
    assert.equal(classifyStep(step), 'tool_error');
  });

  test('ERROR_MESSAGE → tool_error', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      status: 'FINISHED',
      errorMessage: { error: { userErrorMessage: 'Something went wrong' } },
    };
    assert.equal(classifyStep(step), 'tool_error');
  });

  test('TOOL_CALL step → tool_pending', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_TOOL_CALL',
      status: 'IN_PROGRESS',
      toolCall: { toolName: 'search_evidence', input: '{}' },
    };
    assert.equal(classifyStep(step), 'tool_pending');
  });

  test('TOOL_RESULT success → tool_pending', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
      status: 'FINISHED',
      toolResult: { toolName: 'search_evidence', success: true },
    };
    assert.equal(classifyStep(step), 'tool_pending');
  });

  test('TOOL_RESULT failure → tool_error', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
      status: 'FINISHED',
      toolResult: { toolName: 'image_gen', success: false, error: 'quota exceeded' },
    };
    assert.equal(classifyStep(step), 'tool_error');
  });

  test('USER_INPUT → checkpoint (silently skipped)', () => {
    const step = { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'FINISHED' };
    assert.equal(classifyStep(step), 'checkpoint');
  });
});

// ── G3: MCP Tool Error Visibility ──────────────────────────────────

describe('G3: transformer handles tool steps', () => {
  test('TOOL_CALL emits tool_use message', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_TOOL_CALL',
        status: 'IN_PROGRESS',
        toolCall: { toolName: 'search_evidence', input: '{"query":"redis"}' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const toolMsg = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolMsg, 'should emit tool_use message');
    assert.equal(toolMsg.toolName, 'search_evidence');
  });

  test('TOOL_RESULT failure emits error message', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
        status: 'FINISHED',
        toolResult: { toolName: 'image_gen', success: false, error: 'quota exceeded' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg, 'should emit error for failed tool');
    assert.match(errMsg.error, /image_gen.*quota exceeded/);
  });

  test('TOOL_RESULT success emits tool_result message', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_TOOL_RESULT',
        status: 'FINISHED',
        toolResult: { toolName: 'search_evidence', success: true, output: 'Found 3 results' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const resultMsg = msgs.find((m) => m.type === 'tool_result');
    assert.ok(resultMsg, 'should emit tool_result for success');
    assert.equal(resultMsg.toolName, 'search_evidence');
  });
});

// ── G4: Activity Signals ───────────────────────────────────────────

describe('G4: activity signals via system_info', () => {
  test('unknown step type without tool data emits nothing (silent skip)', () => {
    const steps = [{ type: 'CORTEX_STEP_TYPE_JETSKI_ACTION', status: 'IN_PROGRESS' }];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.length, 0, 'unknown step without tool data should be silently skipped');
  });

  test('TOOL_CALL emits system_info activity signal', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_TOOL_CALL',
        status: 'IN_PROGRESS',
        toolCall: { toolName: 'web_search', input: '{}' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const sysMsg = msgs.find((m) => m.type === 'system_info');
    assert.ok(sysMsg, 'should emit system_info for tool call');
    const content = JSON.parse(sysMsg.content);
    assert.equal(content.type, 'tool_activity');
    assert.equal(content.toolName, 'web_search');
  });
});

// ── G10: Model Capacity Classification ───────────────────────────

describe('G10: model_capacity error classification', () => {
  test('ERROR_MESSAGE with "high traffic" → provider_signal warning + model_capacity error', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'DONE',
        errorMessage: {
          error: {
            userErrorMessage: 'Our servers are experiencing high traffic right now, please try again in a minute.',
          },
        },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);

    // Must emit provider_signal BEFORE error
    const warnMsg = msgs.find((m) => m.type === 'provider_signal');
    assert.ok(warnMsg, 'should emit provider_signal warning for capacity error');
    const warnContent = JSON.parse(warnMsg.content);
    assert.equal(warnContent.type, 'warning');
    assert.match(warnContent.message, /上游模型服务端繁忙/);

    // Error must have model_capacity code and attribution text
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg, 'should emit error');
    assert.equal(errMsg.errorCode, 'model_capacity');
    assert.match(errMsg.error, /非 Clowder AI/);

    // Warning must come before error
    const warnIdx = msgs.indexOf(warnMsg);
    const errIdx = msgs.indexOf(errMsg);
    assert.ok(warnIdx < errIdx, 'provider_signal must precede error');
  });

  test('ERROR_MESSAGE with "rate limit" → provider_signal + model_capacity', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'DONE',
        errorMessage: { error: { modelErrorMessage: 'Rate limit exceeded for model gemini-3.1-pro' } },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const warnMsg = msgs.find((m) => m.type === 'provider_signal');
    assert.ok(warnMsg, 'should emit provider_signal for rate limit');
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.equal(errMsg.errorCode, 'model_capacity');
    assert.match(errMsg.error, /非 Clowder AI/);
  });

  test('ERROR_MESSAGE with quota-reset wording → provider_signal + model_capacity', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'DONE',
        errorMessage: {
          error: {
            userErrorMessage: 'You have exhausted your capacity on this model. Your quota will reset after 0s.',
          },
        },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const warnMsg = msgs.find((m) => m.type === 'provider_signal');
    assert.ok(warnMsg, 'quota-style capacity error should still emit provider_signal');
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.equal(errMsg.errorCode, 'model_capacity');
    assert.match(errMsg.error, /非 Clowder AI/);
    assert.match(errMsg.error, /quota will reset after 0s/i);
  });

  test('ERROR_MESSAGE with non-capacity error → errorCode upstream_error (unchanged)', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'DONE',
        errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.equal(errMsg.errorCode, 'upstream_error', 'non-capacity errors stay upstream_error');
  });

  test('ERROR_MESSAGE invalid tool call explains live MCP tool-list / agent-key cause', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'DONE',
        errorMessage: { error: { userErrorMessage: 'The model produced an invalid tool call.' } },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.equal(errMsg.errorCode, 'upstream_error');
    assert.match(errMsg.error, /invalid tool call/i);
    assert.match(errMsg.error, /live MCP tool list/i);
    assert.match(errMsg.error, /agent-key tools/i);
    assert.match(errMsg.error, /cat_cafe_get_thread_context/);
  });
});

// ── Existing transformer behavior (regression) ────────────────────

describe('Transformer regression', () => {
  test('extracts text from PLANNER_RESPONSE', () => {
    const steps = [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: 'meow from bengal' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const textMsgs = msgs.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 1);
    assert.equal(textMsgs[0].content, 'meow from bengal');
    assert.equal(textMsgs[0].catId, catId);
  });

  test('prefers modifiedResponse over response', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: 'original', modifiedResponse: 'modified' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const textMsg = msgs.find((m) => m.type === 'text');
    assert.equal(textMsg.content, 'modified');
  });

  test('propagates replace mode for corrected snapshot replay', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        catCafeTextMode: 'replace',
        plannerResponse: { modifiedResponse: '第一段。插入一句。第二段。' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const textMsg = msgs.find((m) => m.type === 'text');
    assert.equal(textMsg.content, '第一段。插入一句。第二段。');
    assert.equal(textMsg.textMode, 'replace');
  });

  test('emits thinking as system_info before text', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: 'hello', thinking: 'I should say hello' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.filter((m) => m.type === 'system_info').length, 1);
    const textMsg = msgs.find((m) => m.type === 'text');
    assert.equal(textMsg.content, 'hello');
  });

  test('emits error from ERROR_MESSAGE step with upstream_error code', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'CORTEX_STEP_STATUS_DONE',
        errorMessage: { error: { userErrorMessage: 'Agent execution terminated' } },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.filter((m) => m.type === 'error').length, 1);
    assert.ok(msgs[0].error.includes('terminated'));
    assert.equal(msgs[0].errorCode, 'upstream_error', 'ERROR_MESSAGE must have errorCode for fatal detection');
  });

  test('emits stream_error when stopReason is CLIENT_STREAM_ERROR and no text', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg);
    assert.equal(errMsg.errorCode, 'stream_error');
  });

  test('handles combined PLANNER_RESPONSE + ERROR_MESSAGE', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
      },
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'CORTEX_STEP_STATUS_DONE',
        errorMessage: { error: { modelErrorMessage: 'INVALID_ARGUMENT (code 400)' } },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const errors = msgs.filter((m) => m.type === 'error');
    assert.equal(errors.length, 2);
  });
});
