import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';
import {
  finalizeCodexStream,
  transformCodexEvent,
} from '../src/domains/cats/services/agents/providers/codex-event-transform.js';

const owner = { threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' };
const signature = '\n\n[小太阳·砚砚/gpt-6.1-sol🐾]';
const hostOutput = {
  v: 1,
  kind: 'cat_signature',
  producer: 'codex_stream_finalizer',
  role: 'answer_suffix',
  basis: 'runtime_canonical',
};
const native = {
  provider: 'codex',
  runtimeSessionId: 'native',
  turnId: 'turn',
  nativeId: 'answer',
  channel: 'final',
  complete: true,
  textMode: 'replace',
};
function completeAnswer() {
  return accumulateMessageOutputText(createMessageOutputState(owner), { content: '回答。', outputMessage: native });
}

test('production finalizer owns a host suffix without claiming a provider-native channel', () => {
  const state = { hadPriorTextTurn: false, canonicalSignature: signature.slice(2) };
  transformCodexEvent(
    {
      type: 'item.completed',
      thread_id: 'native',
      turn_id: 'turn',
      item: { type: 'agent_message', id: 'answer', phase: 'final_answer', text: '回答。' },
    },
    'codex61-sol',
    state,
  );
  transformCodexEvent({ type: 'turn.completed', usage: {} }, 'codex61-sol', state);
  const message = finalizeCodexStream(state, 'codex61-sol');
  assert.deepEqual(message?.hostOutput, hostOutput);
  assert.equal(message?.outputMessage, undefined);
  assert.equal(message?.content, signature);
});

test('the terminal typed host suffix covers only its own bytes and never expands native ranges', () => {
  const state = accumulateMessageOutputText(completeAnswer(), { content: signature, hostOutput });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, `回答。${signature}`);
  assert.equal(result.layout.status, 'available');
  if (result.layout.status !== 'available') return;
  assert.equal(result.layout.runs[0].end, 3);
  assert.deepEqual(result.layout.hostTail, {
    kind: hostOutput.kind,
    producer: hostOutput.producer,
    basis: hostOutput.basis,
    start: 3,
    end: result.content.length,
    gluePrefixLength: 2,
  });
});

for (const [name, input] of [
  ['bare identical bytes', { content: signature }],
  ['unknown producer', { content: signature, hostOutput: { ...hostOutput, producer: 'provider' } }],
  ['replace tail', { content: signature, textMode: 'replace', hostOutput }],
  ['missing producer prefix', { content: signature.slice(2), hostOutput }],
] as const)
  test(`${name} keeps full text and cannot enable classification`, () => {
    const result = materializeMessageOutput(accumulateMessageOutputText(completeAnswer(), input));
    assert.equal(result.layout.status, 'unavailable');
    assert.ok(result.content.includes(signature.slice(2)));
  });

test('a host tail never supplies a missing complete native final', () => {
  const result = materializeMessageOutput(
    accumulateMessageOutputText(createMessageOutputState(owner), { content: signature, hostOutput }),
  );
  assert.equal(result.layout.status, 'unavailable');
  assert.equal(result.content, signature);
});

test('duplicate host and late native text fail closed and preserve the contradictory body', () => {
  const first = accumulateMessageOutputText(completeAnswer(), { content: signature, hostOutput });
  for (const input of [
    { content: signature, hostOutput },
    { content: 'late', outputMessage: { ...native, nativeId: 'later' } },
  ]) {
    const result = materializeMessageOutput(accumulateMessageOutputText(first, input));
    assert.equal(result.layout.status, 'unavailable');
    assert.ok(result.content.includes(signature.slice(2)));
  }
});

test('provider-observed fallback is stamped as host insertion, never canonical runtime config', () => {
  const message = finalizeCodexStream(
    { hadPriorTextTurn: true, lastTurnTerminal: 'successful', observedSignature: '[Old/gpt-6.1-sol🐾]' },
    'codex61-sol',
  );
  assert.equal(message?.hostOutput?.basis, 'provider_observed_fallback');
  assert.equal(message?.outputMessage, undefined);
});

test('native quoted/fenced/teammate signature text remains in its original output range', () => {
  for (const content of ['引用：[伙伴/gpt-6.1-sol🐾]。', '```\n[伙伴/gpt-6.1-sol🐾]\n```', '[伙伴/gpt-6.1-sol🐾]']) {
    const state = accumulateMessageOutputText(createMessageOutputState(owner), { content, outputMessage: native });
    const result = materializeMessageOutput(accumulateMessageOutputText(state, { content: signature, hostOutput }));
    assert.equal(result.layout.status, 'available');
    if (result.layout.status !== 'available') continue;
    assert.equal(result.layout.runs[0].end, content.length);
    assert.equal(result.content.slice(0, content.length), content);
    assert.equal(result.layout.hostTail?.start, content.length);
  }
});
