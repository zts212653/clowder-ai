import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { AgyNativeProgress } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-progress.js';
import { projectAgyNativeTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';
import { summarizeAgyStreamJsonTurn } from '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js';
import { evaluateVoidHold } from '../dist/domains/cats/services/agents/routing/void-hold-detect.js';

const step = (step_index, fields) => ({
  event: 'step_update',
  step_update: {
    conversation_id: 'native-session',
    step_index,
    state: 'DONE',
    step_type: 'agent_response',
    ...fields,
  },
});
const project = (steps, extra = {}) => {
  const turn = summarizeAgyStreamJsonTurn(
    [
      ...steps,
      {
        event: 'result',
        result: {
          conversation_id: 'native-session',
          status: 'SUCCESS',
          response: 'The protected operation was refused; the explanation is still useful.',
          ...extra,
        },
      },
    ].map(JSON.stringify),
  );
  const metadata = { provider: 'google', model: 'gemini-3.8-flash-high' };
  const messages = projectAgyNativeTurn(
    'gemini38',
    metadata,
    { sessionId: 'native-session', turn, transportError: null },
    false,
  );
  return { turn, metadata, messages };
};

test('a tool permission refusal preserves a useful final and its denial evidence', () => {
  const { messages } = project(
    [
      step(1, {
        step_type: 'tool',
        tool_name: 'run_command',
        state: 'ERROR',
        tool_info: { parameters: { CommandLine: 'refused operation' }, error: { message: 'protected target denied' } },
      }),
    ],
    { denied_actions: [{ action: 'run_command', display_name: 'protected command' }] },
  );
  assert.ok(
    messages.some((message) => message.type === 'text' && message.content.includes('explanation is still useful')),
  );
  assert.equal(messages.at(-1).errorCode, undefined, 'a handled tool refusal is not a broken carrier');
  assert.ok(messages.some((message) => message.type === 'tool_result' && message.toolResultStatus === 'error'));
});

test('protocol drift retains the provider response alongside the typed failure', () => {
  const { messages } = project([
    step(1, { step_type: 'tool', tool_name: 'future_unqualified_tool', tool_info: { output: 'unverified' } }),
  ]);
  assert.equal(messages.at(-1).errorCode, 'AGY_UNEXPECTED_TOOL');
  assert.ok(messages.some((message) => message.type === 'text'));
});

test('the actual AGY MCP resource tools are ordinary native operations', () => {
  for (const tool_name of ['list_resources', 'read_resource']) {
    const { messages } = project([step(1, { step_type: 'tool', tool_name, tool_info: { output: 'resource' } })]);
    assert.equal(messages.at(-1).errorCode, undefined, tool_name);
  }
});

test('unknown native operations are refused by the pre-effect hook, before any post-hoc projection', () => {
  const verdict = decideAgyNativeHookPayload({
    toolCall: { name: 'future_unqualified_tool', args: {} },
    workspacePaths: ['/tmp'],
  });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /unknown|unqualified|unsupported/i);
});

test('per-step usage counts a resumed turn once, normalizes cache and does not double-count thinking', () => {
  // The real tool-call-turn/resume-turn fixtures show: input excludes cached input,
  // thinking is already a subset of output, and upstream total excludes the cached input.
  const first = step(40, {
    usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 50, total_tokens: 120 },
  });
  const second = step(42, {
    usage: { input_tokens: 110, output_tokens: 30, thinking_tokens: 7, cache_read_tokens: 55, total_tokens: 140 },
  });
  const { metadata } = project([first, first, second], {
    num_turns: 15,
    usage: {
      input_tokens: 10000,
      output_tokens: 5000,
      thinking_tokens: 1000,
      cache_read_tokens: 9000,
      total_tokens: 15000,
    },
  });
  assert.equal(metadata.usage.inputTokens, 315);
  assert.equal(metadata.usage.outputTokens, 50);
  assert.equal(metadata.usage.totalTokens, 365);
  assert.equal(metadata.usage.cacheReadTokens, 105);
  assert.equal(metadata.usage.lastTurnInputTokens, 165);
  assert.equal(metadata.diagnostics.agyNative.sessionUsage.totalTokens, 15000);
});

test('recorded AGY resume usage bills only the current request, including its cache', () => {
  const lines = readFileSync(new URL('./fixtures/agy-stream-json/resume-turn.ndjson', import.meta.url), 'utf8').split(
    '\n',
  );
  const turn = summarizeAgyStreamJsonTurn(lines);
  const metadata = { provider: 'google', model: 'gemini-3.8-flash-high' };
  projectAgyNativeTurn('gemini38', metadata, { sessionId: turn.conversationId, turn, transportError: null }, false);
  assert.deepEqual(metadata.usage, {
    inputTokens: 17235,
    outputTokens: 728,
    totalTokens: 17963,
    cacheReadTokens: 12199,
    lastTurnInputTokens: 17235,
  });
});

test('a cumulative result without model-step telemetry must not be billed again', () => {
  const { metadata } = project([], { usage: { input_tokens: 10000, output_tokens: 5000, total_tokens: 15000 } });
  assert.equal(metadata.usage, undefined);
  assert.equal(metadata.diagnostics.agyNative.sessionUsage.totalTokens, 15000);
});

test('official CLI successful resume is not failed by a prior session error retained in result', () => {
  // Fixed 1.3.5: first request HTTP 400; second request succeeds with DONE,
  // matching final text and exit 0, but result still carries the first error.
  const lines = readFileSync(
    new URL('./fixtures/agy-stream-json/resume-after-failed-turn.ndjson', import.meta.url),
    'utf8',
  ).split('\n');
  const turn = summarizeAgyStreamJsonTurn(lines);
  const metadata = { provider: 'google', model: 'gemini-3.8-flash-high' };
  const messages = projectAgyNativeTurn(
    'gemini38',
    metadata,
    { sessionId: turn.conversationId, turn, transportError: null },
    false,
  );
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.equal(metadata.diagnostics.agyNative.upstreamStatus, 'ERROR', 'retain the actual provider envelope');
  assert.match(metadata.diagnostics.agyNative.retainedSessionError, /fixture prior turn interrupted/);
  assert.equal(messages.find((m) => m.type === 'text').content, 'COMPLETE-resumed-success\n');

  for (const [label, mutate, transportError, cancelled] of [
    [
      'current error',
      (events) =>
        events.splice(-1, 0, {
          event: 'step_update',
          step_update: {
            conversation_id: turn.conversationId,
            step_index: 5,
            step_type: 'error_message',
            state: 'DONE',
          },
        }),
    ],
    [
      'unfinished response',
      (events) => {
        events.find((e) => e.step_update?.step_type === 'agent_response').step_update.state = 'ACTIVE';
      },
    ],
    [
      'different final',
      (events) => {
        events.at(-1).result.response = 'A response without matching completed current events';
      },
    ],
    ['transport exit', () => {}, 'CLI exited nonzero'],
    ['cancelled', () => {}, null, true],
  ]) {
    const events = lines.filter(Boolean).map(JSON.parse);
    mutate(events);
    const variant = summarizeAgyStreamJsonTurn(events.map(JSON.stringify));
    const output = projectAgyNativeTurn(
      'gemini38',
      {},
      { sessionId: turn.conversationId, turn: variant, transportError: transportError ?? null },
      cancelled ?? false,
    );
    assert.ok(output.at(-1).errorCode, label);
  }
});

test('a retained result error is never erased without ordered, known and error-free current carrier steps', () => {
  const current = [step(10, { step_type: 'user_input' }), step(12, { text_delta: 'current answer' })];
  const retained = { status: 'ERROR', response: 'current answer', num_turns: 2, error: 'prior failure' };
  assert.equal(project(current, retained).messages.at(-1).errorCode, undefined, 'qualification baseline succeeds');
  for (const step_type of ['agent_response', 'system_message', 'user_input', 'checkpoint']) {
    const { messages } = project([current[0], step(11, { step_type, state: 'ERROR' }), current[1]], retained);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED', `current ${step_type} failed`);
  }
  for (const steps of [
    [current[0], step(11, { step_type: 'future_unknown_step' }), current[1]],
    [step(12, { step_type: 'user_input' }), step(10, { text_delta: 'current answer' })],
  ]) {
    const { messages } = project(steps, retained);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  }
});

test('native MCP calls reach host custody and memory consumers under their canonical tool identity', () => {
  const parameters = {
    ServerName: 'cat-cafe-collab',
    ToolName: 'cat_cafe_hold_ball',
    Arguments: { reason: 'real download' },
  };
  const { messages } = project([
    step(88, { step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { parameters, output: '{"held":true}' } }),
  ]);
  const calls = messages.filter((message) => message.type === 'tool_use');
  assert.equal(calls[0].toolName, 'mcp:cat-cafe-collab/cat_cafe_hold_ball');
  assert.deepEqual(calls[0].toolInput, parameters.Arguments);
  assert.equal(
    evaluateVoidHold({
      text: '我已持球等待下载完成。',
      toolNames: calls.map((call) => call.toolName),
      lineStartMentions: [],
      structuredTargetCats: [],
    }).shouldEmit,
    false,
  );
  const progress = new AgyNativeProgress('gemini38', {
    provider: 'google',
    model: 'gemini-3.8-flash-high',
    sessionId: 'native-session',
  });
  const event = {
    kind: 'step',
    conversationId: 'native-session',
    stepIndex: 88,
    stepType: 'tool',
    toolName: 'call_mcp_tool',
    toolParameters: parameters,
    state: 'ACTIVE',
  };
  const live = progress.step(event);
  assert.equal(live[0].toolName, calls[0].toolName);
  assert.deepEqual(live[0].toolInput, parameters.Arguments);
  const result = progress.step({ ...event, state: 'DONE', toolParameters: null, toolOutput: '{"held":true}' });
  assert.equal(result[0].toolName, calls[0].toolName, 'sparse completion retains the resolved MCP identity');
});
