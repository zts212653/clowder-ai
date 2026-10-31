import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgyNativeProgress } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-progress.js';
import {
  observeAgyNativeTurn,
  projectAgyNativeTurn,
} from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js';

const expected = { agentName: 'unknown-fixture', spawnCwd: '/tmp/unknown-fixture', model: 'gemini-4-argon-high' };
const step = (index, fields) => ({
  event: 'step_update',
  step_update: { conversation_id: 'unknown-session', step_index: index, ...fields },
});
const active = (name = 'wait', index = 1) => step(index, { step_type: 'tool', state: 'ACTIVE', tool_name: name });
// Recorded Yinyin step27 and official 1.4.5 synthetic wait: no type/name/info remains.
const completed = (index = 1) => step(index, { step_type: 'unknown', state: 'DONE', duration_seconds: 0.136533 });

async function replay(steps, { terminal = {}, final = true, cancel = false } = {}) {
  const metadata = { provider: 'google', model: expected.model };
  const progress = new AgyNativeProgress('gemini-argon', metadata);
  const messages = [],
    live = [];
  const controller = new AbortController();
  let observed, batch;
  async function* stream() {
    yield {
      event: 'init',
      conversation_id: 'unknown-session',
      init: {
        agent: expected.agentName,
        cwd: expected.spawnCwd,
        model: expected.model,
        permission_mode: 'request-review',
      },
    };
    yield step(0, { step_type: 'user_input', state: 'DONE' });
    yield* steps;
    if (final) yield step(9, { step_type: 'agent_response', state: 'DONE', text_delta: 'Reply retained.' });
    if (cancel) controller.abort();
    yield {
      event: 'result',
      result: { conversation_id: 'unknown-session', status: 'SUCCESS', response: 'Reply retained.', ...terminal },
    };
  }
  for await (const observation of observeAgyNativeTurn(stream(), expected, controller.signal)) {
    if (observation.kind === 'init') metadata.sessionId = observation.sessionId;
    if (observation.kind === 'step') {
      const emitted = progress.step(observation.event);
      live.push(...emitted);
      messages.push(...emitted);
    }
    if (observation.kind === 'complete') {
      observed = observation.observed;
      batch = projectAgyNativeTurn('gemini-argon', metadata, observed, cancel);
      messages.push(...progress.final(batch));
    }
  }
  return { messages, live, batch, metadata, turn: observed.turn };
}

const results = (messages) => messages.filter((m) => m.type === 'tool_result');

test('paired sparse wait completion finishes the same live tool before terminal, without duplicating text/result', async () => {
  const { messages, live, metadata, turn } = await replay([active(), completed(), completed()]);
  assert.equal(turn.outcome, 'ok');
  assert.deepEqual(turn.anomalies, []);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, true);
  assert.equal(results(live).length, 1, 'completion must be visible before consuming result');
  assert.equal(results(live)[0].toolName, 'wait');
  assert.equal(results(live)[0].toolUseId, 'unknown-session:1');
  assert.equal(results(live)[0].toolResultStatus, 'ok');
  assert.equal(results(messages).length, 1);
  assert.equal(
    messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    'Reply retained.',
  );
  assert.equal(messages.at(-1).errorCode, undefined);
});

test('orphan marker preserves unknown identity and completed reply without claiming tool confirmation', async () => {
  const { messages, live, metadata, turn } = await replay([completed()]);
  assert.equal(turn.outcome, 'unconfirmed');
  assert.deepEqual(turn.unconfirmedStepIndices, [1]);
  assert.equal(turn.stepsComplete, false);
  assert.equal(turn.completedResponseStep, null, 'not reliable recovery evidence');
  assert.equal(turn.toolCalls.length, 0, 'never invent a wait tool identity');
  assert.equal(results(live).length, 0);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.deepEqual(metadata.diagnostics.agyNative.unconfirmedStepIndices, [1]);
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.ok(messages.some((m) => m.semanticEvent?.kind === 'warning' && /身份未确认/.test(m.semanticEvent.message)));
});

for (const name of ['run_command', 'view_file', 'call_mcp_tool']) {
  test(`anonymous completion cannot publish success or rename an existing ${name}`, async () => {
    const { turn, messages, live, metadata } = await replay([active(name), completed()]);
    assert.equal(turn.outcome, 'protocol_error');
    assert.equal(results(live).filter((m) => m.toolResultStatus === 'ok').length, 0);
    assert.equal(results(messages).filter((m) => m.toolResultStatus === 'ok').length, 0);
    assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  });
}

for (const [label, change] of [
  ['future type', { step_type: 'future_native_effect' }],
  ['ACTIVE', { state: 'ACTIVE' }],
  ['ERROR', { state: 'ERROR' }],
  ['explicit tool', { tool_name: 'wait' }],
  ['tool output', { tool_info: { output: 'not a sparse marker' } }],
  ['hidden error', { error: 'denied' }],
  ['missing duration', { duration_seconds: undefined }],
  ['negative duration', { duration_seconds: -1 }],
  ['fractional index', { step_index: 1.5 }],
]) {
  test(`recorded marker compatibility does not accept ${label}`, async () => {
    const done = completed();
    Object.assign(done.step_update, change);
    const { turn, messages } = await replay([done]);
    assert.equal(turn.outcome, 'protocol_error');
    assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  });
}

test('wrong index cannot close an existing wait', async () => {
  const { turn, metadata, live } = await replay([active(), completed(2)]);
  assert.equal(turn.toolCalls[0].state, 'ACTIVE');
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.equal(results(live).length, 0);
});

test('foreign-owner marker is rejected before any successful live result', async () => {
  const done = completed();
  done.step_update.conversation_id = 'foreign-session';
  await assert.rejects(replay([active(), done]), /matching verified init/);
});

test('an orphan marker needs a matching later final response, not merely SUCCESS', async () => {
  const { turn, messages } = await replay([completed()], { final: false });
  assert.equal(turn.outcome, 'protocol_error');
  assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
});

test('an orphan marker cannot repair a mismatched response snapshot', async () => {
  const { turn } = await replay([completed()], { terminal: { response: 'Different snapshot.' } });
  assert.equal(turn.outcome, 'protocol_error');
});

test('orphan compatibility compares the whole visible reply, including pre-tool commentary', async () => {
  const earlier = step(1, { step_type: 'agent_response', state: 'DONE', text_delta: 'Earlier commentary. ' });
  const { turn, messages } = await replay([earlier, completed(2)], {
    terminal: { response: 'Earlier commentary. Reply retained.' },
  });
  assert.equal(turn.outcome, 'unconfirmed');
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.equal(
    messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    'Earlier commentary. Reply retained.',
  );
});

for (const [label, observations] of [
  ['unknown state', [step(1, { step_type: 'tool', tool_name: 'wait', state: 'CANCELLED' }), completed()]],
  ['fractional identity', [active('wait', 1.5), completed(1.5)]],
  ['prior non-tool identity', [step(1, { step_type: 'system_message', state: 'DONE' }), active(), completed()]],
  [
    'intervening unknown type',
    [active(), step(1, { step_type: 'future_native_effect', state: 'ACTIVE' }), completed()],
  ],
]) {
  test(`later sparse wait cannot publish live success after ${label}`, async () => {
    const { live, batch, turn } = await replay(observations);
    assert.equal(turn.outcome, 'protocol_error');
    assert.equal(results(live).filter((m) => m.toolResultStatus === 'ok').length, 0);
    assert.equal(results(batch).filter((m) => m.toolResultStatus === 'ok').length, 0);
  });
}

test('sparse wait completion preserves a prior tool error', async () => {
  const start = active();
  start.step_update.tool_info = { error: { message: 'wait refused' } };
  const { messages, metadata } = await replay([start, completed()]);
  assert.equal(results(messages)[0].toolResultStatus, 'error');
  assert.match(results(messages)[0].content, /wait refused/);
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
});

test('unidentified completion cannot qualify a 401 for automatic continuation', async () => {
  const { messages, metadata } = await replay([completed()], {
    terminal: { status: 'ERROR', error: '401 UNAUTHENTICATED' },
  });
  assert.equal(metadata.diagnostics.agyNative.toolResultsConfirmed, false);
  assert.equal(messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
});

test('denial and cancellation stay independent of completion markers', async () => {
  const denied = await replay([completed()], {
    terminal: { response: '', denied_actions: [{ action: 'write_to_file', display_name: 'write' }] },
  });
  assert.equal(denied.messages.at(-1).errorCode, 'AGY_PERMISSION_DENIED');
  const cancelled = await replay([active(), completed()], { cancel: true });
  assert.equal(cancelled.messages.at(-1).errorCode, 'AGY_CANCELLED');
});
