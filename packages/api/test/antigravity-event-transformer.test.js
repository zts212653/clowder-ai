import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyStep,
  classifyUpstreamError,
  humanErrorMessage,
  isCapacityError,
  isNetworkError,
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

    const warnMsg = msgs.find((m) => m.type === 'provider_signal');
    assert.ok(warnMsg, 'should emit provider_signal warning for capacity error');
    const warnContent = JSON.parse(warnMsg.content);
    assert.equal(warnContent.type, 'warning');
    assert.match(warnContent.message, /上游模型服务繁忙/);

    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg, 'should emit error');
    assert.equal(errMsg.errorCode, 'model_capacity');
    assert.equal(errMsg.error, '上游模型服务繁忙');
    assert.equal(errMsg.metadata.upstreamError.kind, 'capacity');
    assert.equal(errMsg.metadata.upstreamError.transient, true);

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
    assert.equal(errMsg.metadata.upstreamError.kind, 'capacity');
  });

  test('ERROR_MESSAGE with quota-reset wording → provider_signal + model_capacity + raw in metadata', () => {
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
    assert.equal(errMsg.error, '上游模型服务繁忙');
    assert.match(errMsg.metadata.upstreamError.rawReason, /quota will reset/i);
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
    assert.equal(errMsg.errorCode, 'upstream_error');
    assert.equal(errMsg.metadata.upstreamError.kind, 'invalid_tool_call');
    assert.equal(errMsg.metadata.upstreamError.transient, false);
  });

  test('ERROR_MESSAGE invalid tool call uses Chinese user message, raw English in metadata only', () => {
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
    assert.equal(errMsg.error, '工具调用失败');
    assert.match(errMsg.metadata.upstreamError.rawReason, /invalid tool call/i);
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
    const errMsgs = msgs.filter((m) => m.type === 'error');
    assert.equal(errMsgs.length, 1);
    assert.equal(errMsgs[0].error, '上游服务异常');
    assert.equal(errMsgs[0].errorCode, 'upstream_error', 'ERROR_MESSAGE must have errorCode for fatal detection');
    assert.match(errMsgs[0].metadata.upstreamError.rawReason, /terminated/);
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

// ── F061 Phase 3: Error Taxonomy Regression ──────────────────────────

describe('F061 Phase 3: error taxonomy', () => {
  test('AC-2: STOP_REASON_CLIENT_STREAM_ERROR never appears in user message', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'DONE',
        plannerResponse: { stopReason: 'STOP_REASON_CLIENT_STREAM_ERROR' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    for (const m of msgs) {
      if (m.error) assert.doesNotMatch(m.error, /STOP_REASON/);
      if (m.content && typeof m.content === 'string') assert.doesNotMatch(m.content, /STOP_REASON/);
    }
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.equal(errMsg.metadata.upstreamError.kind, 'stream_interrupted');
    assert.equal(errMsg.metadata.upstreamError.transient, true);
  });

  test('AC-3: network error "please try again" is NOT classified as capacity', () => {
    const raw =
      'Encountered retryable error from model provider: There was a network issue connecting to the server, please try again.';
    const info = classifyUpstreamError(raw);
    assert.equal(info.kind, 'network', '"network issue...try again" must be network, not capacity');
    assert.equal(info.transient, true);
  });

  test('AC-3: bare "try again" without transport keyword is NOT network (tightened regex)', () => {
    assert.equal(isNetworkError('Something failed, please try again'), false);
    assert.equal(isCapacityError('Something failed, please try again'), false);
    const info = classifyUpstreamError('Something failed, please try again');
    assert.equal(info.kind, 'unknown', 'bare "try again" without network/server context must not be transient');
  });

  test('AC-3: "high traffic...try again" still matches capacity (capacity takes priority)', () => {
    const info = classifyUpstreamError('high traffic, please try again later');
    assert.equal(info.kind, 'capacity');
  });

  test('network error emits errorCode network_error with provider_signal', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        status: 'DONE',
        errorMessage: {
          error: { userErrorMessage: 'There was a network issue connecting to the server, please try again.' },
        },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const warnMsg = msgs.find((m) => m.type === 'provider_signal');
    assert.ok(warnMsg, 'network errors are transient → should emit provider_signal');
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.equal(errMsg.errorCode, 'network_error');
    assert.equal(errMsg.error, '网络连接异常');
    assert.equal(errMsg.metadata.upstreamError.kind, 'network');
  });

  test('stream_interrupted user message is Chinese, not raw stopReason', () => {
    const errInfo = classifyUpstreamError('STOP_REASON_CLIENT_STREAM_ERROR', 'STOP_REASON_CLIENT_STREAM_ERROR');
    assert.equal(humanErrorMessage(errInfo.kind), '连接中断');
    assert.equal(
      errInfo.rawReason,
      'STOP_REASON_CLIENT_STREAM_ERROR',
      'rawReason must preserve stopReason for diagnostics',
    );
  });

  test('invalid_tool_call is not transient', () => {
    const info = classifyUpstreamError('The model produced an invalid tool call.');
    assert.equal(info.kind, 'invalid_tool_call');
    assert.equal(info.transient, false);
  });

  test('unknown error is not transient', () => {
    const info = classifyUpstreamError('Agent execution terminated');
    assert.equal(info.kind, 'unknown');
    assert.equal(info.transient, false);
  });
});
