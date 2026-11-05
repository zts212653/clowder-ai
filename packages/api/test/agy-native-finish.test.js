import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgyNativeProgress } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-progress.js';
import {
  observeAgyNativeTurn,
  projectAgyNativeTurn,
} from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';

const expected = { agentName: 'finish-fixture', spawnCwd: '/tmp/finish-fixture', model: 'gemini-4-argon-high' };
const step = (index, fields) => ({
  event: 'step_update',
  step_update: { conversation_id: 'finish-session', step_index: index, ...fields },
});
const active = () =>
  step(1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'finish', tool_info: { name: 'finish' } });
// Recorded Argon archive e7a1ff5d..., lines 203–204, 2026-10-17:
// tool/finish/ACTIVE becomes finish/DONE at the SAME index, without tool_name.
const completed = () => step(1, { state: 'DONE', step_type: 'finish', duration_seconds: 0.346756 });

async function replay(steps, terminal = {}) {
  const metadata = { provider: 'google', model: expected.model };
  const progress = new AgyNativeProgress('gemini-argon', metadata);
  const messages = [];
  let observed;
  async function* stream() {
    yield {
      event: 'init',
      conversation_id: 'finish-session',
      init: {
        agent: expected.agentName,
        cwd: expected.spawnCwd,
        model: expected.model,
        permission_mode: 'request-review',
      },
    };
    yield step(0, { state: 'DONE', step_type: 'user_input' });
    yield* steps;
    yield step(3, { state: 'DONE', step_type: 'agent_response', text_delta: 'Review delivered.' });
    yield {
      event: 'result',
      result: { conversation_id: 'finish-session', status: 'SUCCESS', response: 'Review delivered.', ...terminal },
    };
  }
  for await (const observation of observeAgyNativeTurn(stream(), expected)) {
    if (observation.kind === 'init') metadata.sessionId = observation.sessionId;
    if (observation.kind === 'step') messages.push(...progress.step(observation.event));
    if (observation.kind === 'complete') {
      observed = observation.observed;
      messages.push(...progress.final(projectAgyNativeTurn('gemini-argon', metadata, observed, false)));
    }
  }
  return { messages, metadata, turn: observed.turn };
}

const results = (messages) => messages.filter((message) => message.type === 'tool_result');
const warnings = (messages) => messages.filter((message) => message.semanticEvent?.kind === 'warning');

test('recorded finish completion closes the same live tool once and leaves a successful turn', async () => {
  const { messages, metadata, turn } = await replay([active(), completed(), completed()]);
  assert.equal(turn.outcome, 'ok');
  assert.deepEqual(turn.anomalies, []);
  assert.equal(turn.toolCalls[0].state, 'DONE');
  assert.equal(turn.toolCalls[0].toolName, 'finish');
  assert.equal(turn.toolCalls[0].durationSeconds, 0.346756);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, true);
  assert.equal(messages.filter((message) => message.type === 'tool_use').length, 1);
  assert.equal(results(messages).length, 1, 'streaming plus final snapshot must not duplicate the result');
  assert.equal(results(messages)[0].toolUseId, 'finish-session:1');
  assert.equal(results(messages)[0].toolResultStatus, 'ok');
  assert.equal(warnings(messages).length, 0);
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.equal(messages.filter((message) => message.type === 'text').length, 1);
});

test('terminal SUCCESS alone cannot confirm an unfinished finish tool', async () => {
  const { messages, metadata } = await replay([active()]);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.equal(results(messages)[0].toolResultStatus, 'error');
  assert.match(warnings(messages)[0].semanticEvent.message, /unconfirmed.*finish/);
});

test('finish completion at another index cannot complete the original tool', async () => {
  const done = completed();
  done.step_update.step_index = 2;
  const { metadata, turn } = await replay([active(), done]);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.equal(turn.toolCalls.find((call) => call.stepIndex === 1).state, 'ACTIVE');
});

for (const toolName of ['run_command', 'view_file', 'call_mcp_tool']) {
  test(`finish completion cannot publish success for live ${toolName}`, async () => {
    const start = active();
    start.step_update.tool_name = toolName;
    start.step_update.tool_info.parameters = {
      ServerName: 'cat-cafe-memory',
      ToolName: 'cat_cafe_list_recent',
      Arguments: {},
    };
    const { messages, metadata, turn } = await replay([start, completed()]);
    const use = messages.find((message) => message.type === 'tool_use');
    assert.equal(turn.outcome, 'protocol_error');
    assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
    assert.equal(results(messages).filter((message) => message.toolResultStatus === 'ok').length, 0);
    assert.equal(results(messages).length, 1);
    assert.equal(results(messages)[0].toolUseId, use.toolUseId);
    assert.equal(results(messages)[0].toolName, use.toolName);
    assert.equal(results(messages)[0].toolSource, use.toolSource);
  });
}

test('an unresolved MCP start still owns its identity before a tool card can be emitted', async () => {
  const start = active();
  start.step_update.tool_name = 'call_mcp_tool';
  const { messages, turn } = await replay([start, completed()]);
  assert.equal(turn.outcome, 'protocol_error');
  assert.equal(results(messages).filter((message) => message.toolResultStatus === 'ok').length, 0);
  assert.equal(results(messages)[0].toolName, 'call_mcp_tool');
});

test('ordinary tool renaming cannot publish a successful result either', async () => {
  const start = active();
  start.step_update.tool_name = 'run_command';
  const renamed = step(1, { state: 'DONE', step_type: 'tool', tool_name: 'view_file' });
  const { messages } = await replay([start, renamed]);
  assert.equal(results(messages).length, 1);
  assert.equal(results(messages)[0].toolName, 'run_command');
  assert.equal(results(messages)[0].toolResultStatus, 'error');
});

test('restoring the original tool name cannot erase an earlier live identity conflict or error', async () => {
  const start = active();
  start.step_update.tool_name = 'run_command';
  start.step_update.tool_info.error = { message: 'original tool error' };
  const conflicting = step(1, { state: 'ACTIVE', step_type: 'tool', tool_name: 'finish' });
  const restored = step(1, { state: 'DONE', step_type: 'tool', tool_name: 'run_command' });
  const { messages } = await replay([start, conflicting, restored]);
  assert.equal(results(messages).length, 1);
  assert.equal(results(messages)[0].toolName, 'run_command');
  assert.equal(results(messages)[0].toolResultStatus, 'error');
  assert.match(results(messages)[0].content, /original tool error/);
  assert.match(results(messages)[0].content, /identity/);
});

test('a later conflict cannot close an already completed original tool a second time', async () => {
  const start = active();
  start.step_update.tool_name = 'run_command';
  const done = step(1, {
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { output: 'real result' },
  });
  const { messages, turn } = await replay([start, done, completed()]);
  assert.equal(turn.outcome, 'protocol_error');
  assert.equal(results(messages).length, 1);
  assert.equal(results(messages)[0].toolName, 'run_command');
  assert.equal(results(messages)[0].toolResultStatus, 'ok');
  assert.equal(results(messages)[0].content, 'real result');
});

for (const [label, change] of [
  ['unknown type', { step_type: 'future_finish' }],
  ['active finish marker', { state: 'ACTIVE' }],
  ['error finish marker', { state: 'ERROR' }],
  ['conflicting tool name', { tool_name: 'run_command' }],
  ['malformed error', { tool_info: { error: { code: 'DENIED' } } }],
]) {
  test(`finish normalization preserves rejection of ${label}`, async () => {
    const done = completed();
    Object.assign(done.step_update, change);
    const { messages, metadata, turn } = await replay([active(), done]);
    assert.equal(turn.outcome, 'protocol_error');
    assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  });
}

test('finish completion preserves a previously reported tool error', async () => {
  const start = active();
  start.step_update.tool_info.error = { message: 'fixture control refused' };
  const { messages, metadata, turn } = await replay([start, completed()]);
  assert.equal(turn.toolCalls[0].errorMessage, 'fixture control refused');
  assert.equal(results(messages)[0].toolResultStatus, 'error');
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
});

test('finish completion does not clear a current upstream authentication error', async () => {
  const { messages, metadata } = await replay([active(), completed()], {
    status: 'ERROR',
    error: '401 UNAUTHENTICATED',
    num_turns: 1,
  });
  assert.equal(metadata.diagnostics.agyNative.upstreamStatus, 'ERROR');
  assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
});
