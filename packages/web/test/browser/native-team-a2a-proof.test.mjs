import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allA2AInvocationsDone,
  findA2AProof,
  realTaskOutcome,
  validateA2AInvocations,
} from './native-team-a2a-proof.mjs';

const options = { leadId: 'codex', peerId: 'pi', peerMarker: 'PEER', finalMarker: 'FINAL' };
function fixture() {
  return [
    { id: 'u', type: 'user' },
    {
      id: 'lead',
      type: 'assistant',
      catId: 'codex',
      content: 'FINAL',
      lifecycle: { invocationId: 'a', inputMessageIds: ['u'], status: 'completed', startedAt: 1 },
    },
    { id: 'handoff', catId: 'codex', lifecycle: { producerInvocationId: 'a' } },
    {
      id: 'peer',
      type: 'assistant',
      catId: 'pi',
      content: 'PEER',
      lifecycle: { invocationId: 'b', inputMessageIds: ['handoff'], status: 'completed', completedAt: 10 },
    },
    { id: 'return', catId: 'pi', content: 'PEER', timestamp: 9, lifecycle: { producerInvocationId: 'b' } },
    {
      id: 'final',
      type: 'assistant',
      catId: 'codex',
      content: 'FINAL',
      lifecycle: {
        invocationId: 'c',
        inputMessageIds: ['return'],
        status: 'completed',
        startedAt: 11,
        completedAt: 12,
      },
    },
  ];
}
test('accepts a persisted delegation/return chain despite an earlier premature model claim', () => {
  assert.deepEqual(findA2AProof(fixture(), options), {
    userMessageId: 'u',
    initialInvocationId: 'a',
    delegationMessageId: 'handoff',
    peerMessageId: 'peer',
    peerInvocationId: 'b',
    finalMessageId: 'final',
    finalInvocationId: 'c',
    returnInvocationId: 'c',
  });
});
test('model claims and response array order cannot stand in for a peer return', () => {
  const messages = fixture();
  messages.pop();
  assert.equal(findA2AProof(messages, options), undefined);
});
test('an unrelated peer invocation cannot prove delegation by the initial lead', () => {
  const messages = fixture();
  messages[2].lifecycle.producerInvocationId = 'foreign';
  assert.equal(findA2AProof(messages, options), undefined);
});
test('a real immutable callback result can be consumed while its producer finishes the turn', () => {
  const messages = fixture();
  messages[5].lifecycle.startedAt = 9;
  assert.equal(findA2AProof(messages, options)?.finalInvocationId, 'c');
});
test('a callback that does not contain the peer result cannot prove integration', () => {
  const messages = fixture();
  messages[4].content = 'still thinking';
  assert.equal(findA2AProof(messages, options), undefined);
});
test('a final reply unrelated to the peer input cannot prove integration', () => {
  const messages = fixture();
  messages[5].lifecycle.inputMessageIds = ['u'];
  assert.equal(findA2AProof(messages, options), undefined);
});
test('an incomplete peer or integration started before its result was published cannot pass', () => {
  for (const mutate of [
    (messages) => {
      messages[3].lifecycle.status = 'processing';
    },
    (messages) => {
      messages[5].lifecycle.startedAt = 8;
    },
  ]) {
    const messages = fixture();
    mutate(messages);
    assert.equal(findA2AProof(messages, options), undefined);
  }
});

test('a streamed task marker cannot pass before the actual client completes', () => {
  const reply = {
    id: 'r',
    catId: 'pi',
    type: 'assistant',
    content: 'TOKEN',
    lifecycle: { invocationId: 'a', status: 'processing' },
  };
  assert.equal(realTaskOutcome([reply], 'pi', 'TOKEN'), undefined);
  reply.lifecycle.status = 'completed';
  assert.deepEqual(realTaskOutcome([reply], 'pi', 'TOKEN'), { status: 'passed', messageId: 'r' });
});
test('a completed greeting is an explicit failure, never proof of a successful task', () => {
  const reply = {
    id: 'r',
    catId: 'claude-code',
    type: 'assistant',
    content: '收到。有什么帮助？',
    lifecycle: { invocationId: 'a', status: 'completed' },
  };
  assert.deepEqual(realTaskOutcome([reply], 'claude-code', 'TOKEN'), {
    status: 'failed',
    messageId: 'r',
    reason: 'completed_without_task_result',
  });
});
test('canceled and failed terminal replies cannot pass even if they contain a partial marker', () => {
  for (const status of ['failed', 'canceled', 'interrupted']) {
    const reply = {
      id: 'r',
      catId: 'pi',
      type: 'assistant',
      content: 'TOKEN',
      lifecycle: { invocationId: 'a', status },
    };
    assert.equal(realTaskOutcome([reply], 'pi', 'TOKEN')?.status, 'failed');
  }
});
test('another cat, user echo or unverified callback cannot satisfy a real task', () => {
  const messages = [
    { id: 'u', type: 'user', content: 'TOKEN' },
    {
      id: 'p',
      catId: 'codex',
      type: 'assistant',
      content: 'TOKEN',
      lifecycle: { invocationId: 'b', status: 'completed' },
    },
    {
      id: 'c',
      catId: 'pi',
      type: 'assistant',
      content: 'TOKEN',
      lifecycle: { producerInvocationId: 'a', status: 'completed' },
    },
  ];
  assert.equal(realTaskOutcome(messages, 'pi', 'TOKEN'), undefined);
});

function fixtureWithObservation() {
  const messages = fixture();
  messages[5].content = '回传已收到，成果已交付';
  messages[1].lifecycle.completedAt = 12;
  messages[1].toolEvents = [
    {
      type: 'tool_use',
      toolUseId: 'read1',
      toolName: 'mcp:cat-cafe-collab/cat_cafe_get_thread_context',
      timestamp: 10,
    },
    {
      type: 'tool_result',
      toolUseId: 'read1',
      status: 'ok',
      timestamp: 11,
      detail:
        'mcp:cat-cafe-collab/cat_cafe_get_thread_context (completed)\n' +
        JSON.stringify({
          messages: [{ id: 'return', from: { kind: 'agent', catId: 'pi' }, content: 'PEER' }],
        }),
    },
  ];
  return messages;
}

test('a native MCP context read proves a real peer result consumed within the initial lead turn', () => {
  const proof = findA2AProof(fixtureWithObservation(), options);
  assert.ok(proof);
  assert.equal(proof.finalInvocationId, 'a');
  assert.equal(proof.observationToolUseId, 'read1');
  assert.equal(proof.observedMessageId, 'return');
  assert.equal(proof.returnInvocationId, 'c');
});

test('truncated display JSON is insufficient; a complete native observation can prove the same causal read', () => {
  const messages = fixtureWithObservation();
  const full = messages[1].toolEvents;
  messages[1].toolEvents = full.map((event) =>
    event.type === 'tool_result' ? { ...event, detail: `${event.detail.slice(0, 50)}…` } : event,
  );
  assert.equal(findA2AProof(messages, options), undefined);
  const proof = findA2AProof(messages, { ...options, nativeToolEvents: new Map([['a', full]]) });
  assert.equal(proof?.observationToolUseId, 'read1');
  assert.equal(proof?.observedMessageId, 'return');
  assert.equal(findA2AProof(messages, { ...options, nativeToolEvents: new Map([['foreign', full]]) }), undefined);
});

test('observing the peer result is insufficient while the actual return invocation is absent or processing', () => {
  for (const mutate of [
    (messages) => {
      messages.pop();
    },
    (messages) => {
      messages[5].lifecycle.status = 'processing';
    },
    (messages) => {
      messages[5].lifecycle.status = 'canceled';
    },
  ]) {
    const messages = fixtureWithObservation();
    mutate(messages);
    assert.equal(findA2AProof(messages, options), undefined);
  }
});

test('a failed, unrelated, future or forged tool observation cannot prove consumption', () => {
  for (const mutate of [
    (messages) => {
      messages[1].toolEvents[1].status = 'error';
    },
    (messages) => {
      messages[1].toolEvents[0].toolName = 'mcp:external/cat_cafe_get_thread_context';
    },
    (messages) => {
      messages[1].toolEvents[1].toolUseId = 'foreign';
    },
    (messages) => {
      messages[1].toolEvents[1].timestamp = 13;
    },
    (messages) => {
      messages[4].lifecycle.producerInvocationId = 'foreign';
    },
    (messages) => {
      messages[1].toolEvents[1].detail = 'received PEER';
    },
  ]) {
    const messages = fixtureWithObservation();
    mutate(messages);
    assert.equal(findA2AProof(messages, options), undefined);
  }
});
test('an admitted but still running, canceled or failed return prevents a successful journey', () => {
  for (const status of ['running', 'canceled', 'failed'])
    assert.equal(allA2AInvocationsDone([{ status: 'done' }, { status: 'done' }, { status }]), false);
  assert.equal(allA2AInvocationsDone([{ status: 'done' }, { status: 'done' }]), false);
  assert.equal(allA2AInvocationsDone([{ status: 'done' }, { status: 'done' }, { status: 'done' }]), true);
});

function trajectoryFixture(extra) {
  return [
    { invocationId: 'a', catId: 'codex', status: 'done', startedAt: 1, completedAt: 4 },
    { invocationId: 'b', catId: 'pi', status: 'done', startedAt: 5, completedAt: 10 },
    { invocationId: 'c', catId: 'codex', status: 'done', startedAt: 11, completedAt: 14 },
    extra,
  ];
}

function proofForValidation() {
  return {
    userMessageId: 'u',
    initialInvocationId: 'a',
    peerMessageId: 'peer',
    peerInvocationId: 'b',
    finalMessageId: 'final',
    finalInvocationId: 'c',
    returnInvocationId: 'c',
  };
}

test('accepts a post-result acknowledgement when it consumes the persisted result', () => {
  const messages = fixture();
  messages.push({
    id: 'ack',
    type: 'assistant',
    catId: 'pi',
    content: '已收到并确认交付',
    lifecycle: { invocationId: 'd', inputMessageIds: ['final'], status: 'completed', startedAt: 15 },
  });
  assert.deepEqual(
    validateA2AInvocations(
      messages,
      trajectoryFixture({ invocationId: 'd', catId: 'pi', status: 'done', startedAt: 15 }),
      {
        ...options,
        proof: proofForValidation(),
      },
    ),
    {
      ok: true,
      acceptedConfirmations: ['d'],
      rejectedInvocations: [],
      coreInvocationIds: ['a', 'b', 'c'],
    },
  );
});

test('rejects a duplicate peer computation that consumes the original handoff', () => {
  const messages = fixture();
  messages.push({
    id: 'duplicate',
    type: 'assistant',
    catId: 'pi',
    content: 'PEER=9',
    lifecycle: { invocationId: 'd', inputMessageIds: ['handoff'], status: 'completed', startedAt: 15 },
  });
  const result = validateA2AInvocations(
    messages,
    trajectoryFixture({ invocationId: 'd', catId: 'pi', status: 'done', startedAt: 15 }),
    { ...options, proof: proofForValidation() },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'duplicate_handoff' }]);
});

test('rejects an extra invocation that emits another task result marker', () => {
  const messages = fixture();
  messages.push({
    id: 'duplicate-result',
    type: 'assistant',
    catId: 'pi',
    content: '已确认 A2A_FINAL=9',
    lifecycle: { invocationId: 'd', inputMessageIds: ['final'], status: 'completed', startedAt: 15 },
  });
  const result = validateA2AInvocations(
    messages,
    trajectoryFixture({ invocationId: 'd', catId: 'pi', status: 'done', startedAt: 15 }),
    { ...options, proof: proofForValidation() },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'new_task_result' }]);
});

test('rejects a completed invocation from an unrelated role or input chain', () => {
  const messages = fixture();
  messages.push({
    id: 'unrelated',
    type: 'assistant',
    catId: 'kimi',
    content: '我来帮忙',
    lifecycle: { invocationId: 'd', inputMessageIds: ['u'], status: 'completed', startedAt: 15 },
  });
  const result = validateA2AInvocations(
    messages,
    trajectoryFixture({ invocationId: 'd', catId: 'kimi', status: 'done', startedAt: 15 }),
    { ...options, proof: proofForValidation() },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'kimi', reason: 'unrelated_role' }]);
});

function validateExtra(messages, extra = { invocationId: 'd', catId: 'pi', status: 'done', startedAt: 15 }) {
  return validateA2AInvocations(messages, trajectoryFixture(extra), { ...options, proof: proofForValidation() });
}

function pushAck(messages, overrides = {}) {
  messages.push({
    id: 'ack',
    type: 'assistant',
    catId: 'pi',
    content: '已收到并确认交付',
    lifecycle: { invocationId: 'd', inputMessageIds: ['final'], status: 'completed', startedAt: 15, ...overrides },
  });
}

test('RED: an extra invocation mixing the final result with the original user request is rejected', () => {
  const messages = fixture();
  messages.push({
    id: 'mixed-inputs',
    type: 'assistant',
    catId: 'pi',
    content: '收到，我再算一遍',
    lifecycle: {
      invocationId: 'd',
      inputMessageIds: ['final', 'u'],
      status: 'completed',
      startedAt: 15,
    },
  });
  const result = validateExtra(messages);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'user_request_input' }]);
});

test('RED: an extra invocation consuming a peer progress message is rejected even though the peer invoked', () => {
  const messages = fixture();
  messages.push({
    id: 'peer-progress',
    type: 'assistant',
    catId: 'pi',
    content: 'PEER 计算中…',
    lifecycle: { invocationId: 'b', status: 'processing', startedAt: 9 },
  });
  messages.push({
    id: 'progress-ack',
    type: 'assistant',
    catId: 'pi',
    content: '已收到伙伴进展',
    lifecycle: { invocationId: 'd', inputMessageIds: ['peer-progress'], status: 'completed', startedAt: 15 },
  });
  const result = validateExtra(messages);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'unverified_result' }]);
});

test('RED: an extra invocation consuming a streamed task-marker segment is rejected', () => {
  const messages = fixture();
  messages.push({
    id: 'peer-partial',
    type: 'assistant',
    catId: 'pi',
    content: 'PEER',
    timestamp: 9,
    lifecycle: { producerInvocationId: 'b', status: 'processing' },
  });
  messages.push({
    id: 'partial-ack',
    type: 'assistant',
    catId: 'pi',
    content: '已收到结果',
    lifecycle: { invocationId: 'd', inputMessageIds: ['peer-partial'], status: 'completed', startedAt: 15 },
  });
  const result = validateExtra(messages);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'unverified_result' }]);
});

test('RED: an extra invocation that produces a new handoff is rejected', () => {
  const messages = fixture();
  pushAck(messages);
  messages.push({
    id: 'follow-up-handoff',
    catId: 'pi',
    content: '继续交给 kimi',
    lifecycle: { producerInvocationId: 'd' },
  });
  const result = validateExtra(messages);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'new_dispatch' }]);
});

test('RED: a confirmation of a result without completedAt cannot claim the result was published', () => {
  const messages = fixture();
  delete messages[5].lifecycle.completedAt;
  pushAck(messages);
  const result = validateExtra(messages);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'unproven_publication' }]);
});

test('RED: a confirmation that started before the consumed result completed is rejected', () => {
  const messages = fixture();
  messages[5].lifecycle.completedAt = 16;
  pushAck(messages);
  const result = validateExtra(messages);
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejectedInvocations, [{ invocationId: 'd', catId: 'pi', reason: 'early_confirmation' }]);
});

test('RED: an extra invocation without persisted input or timing evidence is rejected', () => {
  const messages = fixture();
  messages.push({
    id: 'no-input-ack',
    type: 'assistant',
    catId: 'pi',
    content: '收到',
    lifecycle: { invocationId: 'd', status: 'completed', startedAt: 15 },
  });
  assert.deepEqual(validateExtra(messages).rejectedInvocations, [
    { invocationId: 'd', catId: 'pi', reason: 'missing_result_input' },
  ]);
  const late = fixture();
  pushAck(late);
  assert.deepEqual(validateExtra(late, { invocationId: 'd', catId: 'pi', status: 'done' }).rejectedInvocations, [
    { invocationId: 'd', catId: 'pi', reason: 'unproven_timing' },
  ]);
});

test('accepts a short confirmation after the consumed result has a real completedAt', () => {
  const messages = fixture();
  messages[5].lifecycle.completedAt = 12;
  pushAck(messages);
  assert.deepEqual(validateExtra(messages), {
    ok: true,
    acceptedConfirmations: ['d'],
    rejectedInvocations: [],
    coreInvocationIds: ['a', 'b', 'c'],
  });
});

test('accepts a confirmation that consumes the proof-verified peer result rather than the final reply', () => {
  const messages = fixture();
  messages.push({
    id: 'peer-ack',
    type: 'assistant',
    catId: 'pi',
    content: '伙伴已确认收到',
    lifecycle: { invocationId: 'd', inputMessageIds: ['peer'], status: 'completed', startedAt: 15 },
  });
  assert.deepEqual(validateExtra(messages), {
    ok: true,
    acceptedConfirmations: ['d'],
    rejectedInvocations: [],
    coreInvocationIds: ['a', 'b', 'c'],
  });
});

test('accepts a confirmation consuming a verified final result produced by the initial invocation', () => {
  const messages = fixture();
  messages[1].lifecycle.completedAt = 12;
  messages.push({
    id: 'observed-ack',
    type: 'assistant',
    catId: 'pi',
    content: '已收到最终答复',
    lifecycle: { invocationId: 'd', inputMessageIds: ['lead'], status: 'completed', startedAt: 15 },
  });
  const proof = {
    ...proofForValidation(),
    finalMessageId: 'lead',
    finalInvocationId: 'a',
  };
  assert.deepEqual(
    validateA2AInvocations(
      messages,
      trajectoryFixture({ invocationId: 'd', catId: 'pi', status: 'done', startedAt: 15 }),
      { ...options, proof },
    ),
    {
      ok: true,
      acceptedConfirmations: ['d'],
      rejectedInvocations: [],
      coreInvocationIds: ['a', 'b', 'c'],
    },
  );
});
