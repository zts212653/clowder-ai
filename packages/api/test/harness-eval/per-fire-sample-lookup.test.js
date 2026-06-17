/**
 * F192 Phase D — per-fire sample drilldown helper tests.
 *
 * Locks the contract 砚砚 made explicit:
 *   - traceId/spanId is the primary join key (must work first)
 *   - HMAC scan is bounded (caller decides window; default 500 candidates)
 *   - lookup is HONEST about success/failure — no guessing on collision
 *   - missing message store hook → status `message_lookup_unavailable`
 *     (not silent null)
 *   - artifact ↔ message join uses only HMAC compare (no raw IDs surface)
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const { lookupByEvalSampleRef } = await import('../../dist/infrastructure/harness-eval/per-fire-sample-lookup.js');

/** Deterministic toy HMAC: sha256-hex prefix. Test-only. */
function toyHmac(raw) {
  return `hash-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

function makeSpanWithEvent({
  spanId = 's-1',
  traceId = 't-1',
  msgIdHash,
  invIdHash,
  threadIdHash = 'hash-thread-default',
  agentId = 'codex',
  threadSystemKind = 'product',
  trigger = 'reject',
  timeMs = 1700000000000,
} = {}) {
  return {
    traceId,
    spanId,
    name: 'cat_cafe.route',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events: [
      {
        name: 'c2.verdict_without_pass_fired',
        timeMs,
        attributes: {
          messageId: msgIdHash,
          invocationId: invIdHash,
          threadId: threadIdHash,
          'agent.id': agentId,
          'thread.system_kind': threadSystemKind,
          trigger,
        },
      },
    ],
  };
}

test('lookupByEvalSampleRef: span_not_found → status reflects it, no message lookup attempted', async () => {
  const messageLookup = {
    listCandidateMessageIds: () => {
      throw new Error('should not be called when span missing');
    },
  };
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-missing' },
    {
      traceLookup: { getSpan: () => null },
      messageLookup,
      hmac: toyHmac,
    },
  );
  assert.equal(result.span, null);
  assert.equal(result.sample, null);
  assert.equal(result.status.message, 'span_not_found');
  assert.equal(result.status.invocation, 'span_not_found');
});

test('lookupByEvalSampleRef: event_not_found_in_span → status when span exists but lacks our event', async () => {
  const span = {
    traceId: 't-1',
    spanId: 's-1',
    name: 'cat_cafe.route',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events: [{ name: 'tool_use', timeMs: 100, attributes: {} }],
  };
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      hmac: toyHmac,
    },
  );
  assert.equal(result.span, span);
  assert.equal(result.sample, null);
  assert.equal(result.status.message, 'event_not_found_in_span');
  assert.equal(result.status.invocation, 'event_not_found_in_span');
});

test('lookupByEvalSampleRef: message_lookup_unavailable when no messageLookup injected', async () => {
  const rawMsgId = 'msg-real-abc';
  const span = makeSpanWithEvent({ msgIdHash: toyHmac(rawMsgId) });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      // no messageLookup
      hmac: toyHmac,
    },
  );
  assert.equal(result.status.message, 'message_lookup_unavailable');
  assert.equal(result.messageId, null);
  // sample is still reconstructed from event attrs
  assert.ok(result.sample);
  assert.equal(result.sample.spanId, 's-1');
});

test('lookupByEvalSampleRef: hit — bounded HMAC scan finds exactly one match', async () => {
  const rawMsgId = 'msg-real-xyz';
  const rawInvId = 'inv-real-xyz';
  const span = makeSpanWithEvent({ msgIdHash: toyHmac(rawMsgId), invIdHash: toyHmac(rawInvId) });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => ['msg-other-1', rawMsgId, 'msg-other-2'] },
      invocationLookup: { listCandidateInvocationIds: () => [rawInvId] },
      hmac: toyHmac,
    },
  );
  assert.equal(result.status.message, 'hit');
  assert.equal(result.messageId, rawMsgId);
  assert.equal(result.status.invocation, 'hit');
  assert.equal(result.invocationId, rawInvId);
});

test('lookupByEvalSampleRef: message_not_found when scan yields zero matches', async () => {
  const span = makeSpanWithEvent({ msgIdHash: toyHmac('msg-missing') });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => ['msg-other-1', 'msg-other-2'] },
      hmac: toyHmac,
    },
  );
  assert.equal(result.status.message, 'message_not_found');
  assert.equal(result.messageId, null);
});

test('lookupByEvalSampleRef: multiple_candidates_fail_closed when ≥2 raw ids HMAC to same hash', async () => {
  // Construct a contrived HMAC collision by stubbing the hmac fn to return same hash for two ids.
  const collidingHmac = (raw) => (raw === 'msg-a' || raw === 'msg-b' ? 'hash-COLLISION' : `hash-${raw}`);
  const span = makeSpanWithEvent({ msgIdHash: 'hash-COLLISION' });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => ['msg-a', 'msg-b'] },
      hmac: collidingHmac,
    },
  );
  assert.equal(result.status.message, 'multiple_candidates_fail_closed');
  assert.equal(result.messageId, null, 'fail-closed: never pick a candidate when collision detected');
});

test('lookupByEvalSampleRef: scan respects maxCandidates cap (bounded brute-force)', async () => {
  const rawMsgId = 'msg-target';
  const span = makeSpanWithEvent({ msgIdHash: toyHmac(rawMsgId) });
  let observedCap = null;
  await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: {
        listCandidateMessageIds: ({ maxCandidates }) => {
          observedCap = maxCandidates;
          return [rawMsgId];
        },
      },
      hmac: toyHmac,
      maxCandidates: 50,
    },
  );
  assert.equal(observedCap, 50, 'helper passes maxCandidates through to lookup hook');
});

test('lookupByEvalSampleRef: default maxCandidates=500 when caller omits', async () => {
  const span = makeSpanWithEvent({ msgIdHash: toyHmac('msg-target') });
  let observedCap = null;
  await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: {
        listCandidateMessageIds: ({ maxCandidates }) => {
          observedCap = maxCandidates;
          return [];
        },
      },
      hmac: toyHmac,
    },
  );
  assert.equal(observedCap, 500);
});

test('lookupByEvalSampleRef: thread_scope_missing when event lacks threadId attr (cloud R1 P2 fail-closed)', async () => {
  // Construct a span with our event but NO threadId attribute. Helper must NOT
  // proceed to lookup with empty threadIdHash (would violate thread-scoped contract).
  const span = {
    traceId: 't-1',
    spanId: 's-1',
    name: 'cat_cafe.route',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events: [
      {
        name: 'c2.verdict_without_pass_fired',
        timeMs: 1000,
        attributes: {
          messageId: toyHmac('msg-x'),
          invocationId: toyHmac('inv-x'),
          // NO threadId — malformed event
          'agent.id': 'codex',
          trigger: 'reject',
        },
      },
    ],
  };
  let messageHookCalled = false;
  await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: {
        listCandidateMessageIds: () => {
          messageHookCalled = true;
          return [];
        },
      },
      hmac: toyHmac,
    },
  );
  assert.equal(messageHookCalled, false, 'must NOT call lookup hook when threadIdHash absent (fail-closed)');
});

test('lookupByEvalSampleRef: passes threadIdHash through to lookup hook (local R1 P1-3: thread-scoped scan)', async () => {
  const span = makeSpanWithEvent({
    msgIdHash: toyHmac('msg-target'),
    threadIdHash: 'hash-thread-xyz',
  });
  let observedOpts = null;
  await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: {
        listCandidateMessageIds: (opts) => {
          observedOpts = opts;
          return [];
        },
      },
      invocationLookup: {
        listCandidateInvocationIds: () => [],
      },
      hmac: toyHmac,
    },
  );
  assert.equal(
    observedOpts.threadIdHash,
    'hash-thread-xyz',
    'helper must pass threadIdHash so lookup is thread-scoped',
  );
  assert.equal(observedOpts.aroundTimeMs, 1700000000000);
  assert.equal(observedOpts.maxCandidates, 500);
});

test('lookupByEvalSampleRef: returns sample reconstructed from event attrs (for downstream artifact rendering)', async () => {
  const span = makeSpanWithEvent({
    msgIdHash: 'hash-msg',
    invIdHash: 'hash-inv',
    threadIdHash: 'hash-thread',
    agentId: 'opus',
    trigger: 'p1p2',
    timeMs: 1700000000000,
  });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    { traceLookup: { getSpan: () => span }, hmac: toyHmac },
  );
  assert.ok(result.sample);
  assert.equal(result.sample.messageIdHash, 'hash-msg');
  assert.equal(result.sample.invocationIdHash, 'hash-inv');
  assert.equal(result.sample.threadIdHash, 'hash-thread');
  assert.equal(result.sample.agentId, 'opus');
  assert.equal(result.sample.trigger, 'p1p2');
  assert.equal(result.sample.firedAt, new Date(1700000000000).toISOString());
});

// F192 Phase D — eval:a2a 2026-06-10 build verdict: parameterize lookup by event name
// so the helper can drilldown void-hold fires (event 'c2.void_hold_fired') with the
// same HMAC + bounded-scan discipline as verdict-without-pass. Default event remains
// 'c2.verdict_without_pass_fired' for back-compat.

function makeSpanWithCustomEvent({
  spanId = 's-1',
  traceId = 't-1',
  eventName = 'c2.verdict_without_pass_fired',
  msgIdHash,
  invIdHash,
  threadIdHash = 'hash-thread-default',
  agentId = 'opus-47',
  threadSystemKind = 'product',
  trigger = 'cn_chiqiu',
  timeMs = 1700000000000,
} = {}) {
  return {
    traceId,
    spanId,
    name: 'cat_cafe.route',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events: [
      {
        name: eventName,
        timeMs,
        attributes: {
          messageId: msgIdHash,
          invocationId: invIdHash,
          threadId: threadIdHash,
          'agent.id': agentId,
          'thread.system_kind': threadSystemKind,
          trigger,
        },
      },
    ],
  };
}

test('lookupByEvalSampleRef: void-hold variant — eventName=c2.void_hold_fired finds event + builds sample', async () => {
  const rawMsgId = 'msg-vh-1';
  const span = makeSpanWithCustomEvent({
    eventName: 'c2.void_hold_fired',
    msgIdHash: toyHmac(rawMsgId),
    invIdHash: toyHmac('inv-vh-1'),
    trigger: 'cn_wo_chi_qiu',
    timeMs: 1750000000000,
  });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => [rawMsgId] },
      invocationLookup: { listCandidateInvocationIds: () => ['inv-vh-1'] },
      hmac: toyHmac,
      eventName: 'c2.void_hold_fired',
    },
  );
  assert.equal(result.status.message, 'hit');
  assert.equal(result.messageId, rawMsgId);
  assert.equal(result.sample.trigger, 'cn_wo_chi_qiu');
  assert.equal(result.sample.firedAt, new Date(1750000000000).toISOString());
});

test('lookupByEvalSampleRef: eventName mismatch (asking for void-hold on a verdict span) → event_not_found_in_span', async () => {
  // Span carries verdict-without-pass event; caller asks for void-hold → must fail closed,
  // not silently fall back to the verdict event.
  const span = makeSpanWithCustomEvent({
    eventName: 'c2.verdict_without_pass_fired',
    msgIdHash: toyHmac('msg-v-1'),
    trigger: 'reject',
  });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => ['msg-v-1'] },
      hmac: toyHmac,
      eventName: 'c2.void_hold_fired',
    },
  );
  assert.equal(result.status.message, 'event_not_found_in_span');
  assert.equal(result.sample, null);
});

test('lookupByEvalSampleRef: default eventName remains verdict_without_pass_fired (back-compat)', async () => {
  // Existing callers that don't pass eventName must still resolve verdict fires.
  const rawMsgId = 'msg-default-1';
  const span = makeSpanWithCustomEvent({
    eventName: 'c2.verdict_without_pass_fired',
    msgIdHash: toyHmac(rawMsgId),
    trigger: 'p1p2',
  });
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => [rawMsgId] },
      hmac: toyHmac,
      // eventName omitted — must default to verdict_without_pass_fired
    },
  );
  assert.equal(result.status.message, 'hit');
  assert.equal(result.messageId, rawMsgId);
});

test('lookupByEvalSampleRef: C1 variant — eventName=c1.zombie_hold_fired finds event + builds sample', async () => {
  const rawPriorTaskId = 'hold-ball-1700000000000-abc123';
  const span = {
    traceId: 't-c1',
    spanId: 's-c1',
    name: 'cat_cafe.a2a.c1.zombie_hold_sample',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events: [
      {
        name: 'c1.zombie_hold_fired',
        timeMs: 1750000000000,
        attributes: {
          messageId: toyHmac(rawPriorTaskId),
          invocationId: toyHmac('inv-c1-1'),
          threadId: 'hash-thread-c1',
          'agent.id': 'opus-47',
          'thread.system_kind': 'product',
          trigger: 'prior_imminent',
          priorTaskIdHash: toyHmac(rawPriorTaskId),
          newTaskIdHash: toyHmac('hold-ball-1700000060000-def456'),
        },
      },
    ],
  };
  const result = await lookupByEvalSampleRef(
    { traceId: 't-c1', spanId: 's-c1' },
    {
      traceLookup: { getSpan: () => span },
      messageLookup: { listCandidateMessageIds: () => [rawPriorTaskId] },
      invocationLookup: { listCandidateInvocationIds: () => ['inv-c1-1'] },
      hmac: toyHmac,
      eventName: 'c1.zombie_hold_fired',
    },
  );
  assert.equal(result.status.message, 'hit');
  assert.equal(result.messageId, rawPriorTaskId, 'C1 messageId resolves to the cancelled priorTaskId');
  assert.equal(result.sample.trigger, 'prior_imminent');
});

test('lookupByEvalSampleRef: eventName mismatch (asking for C1 on a C2 span) → event_not_found_in_span', async () => {
  const span = {
    traceId: 't-1',
    spanId: 's-1',
    name: 'cat_cafe.route',
    startTimeMs: 0,
    endTimeMs: 0,
    durationMs: 0,
    status: { code: 0 },
    attributes: {},
    events: [
      {
        name: 'c2.verdict_without_pass_fired',
        timeMs: 1700000000000,
        attributes: {
          messageId: toyHmac('msg-v-1'),
          threadId: 'hash-thread-v',
          'agent.id': 'codex',
          'thread.system_kind': 'product',
          trigger: 'reject',
        },
      },
    ],
  };
  const result = await lookupByEvalSampleRef(
    { traceId: 't-1', spanId: 's-1' },
    {
      traceLookup: { getSpan: () => span },
      hmac: toyHmac,
      eventName: 'c1.zombie_hold_fired',
    },
  );
  assert.equal(result.status.message, 'event_not_found_in_span');
  assert.equal(result.sample, null);
});
